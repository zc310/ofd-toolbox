// Worker：命令分发、流式产物接收、取消与错误分类。
//
// Worker 存在的唯一理由是把 50MB 量级的 WASM 和随之而来的长时间计算挪出主线程。
// 主线程因此始终可交互——进度条、取消按钮和页面滚动都不会被卡住。
//
// 协议：
//   请求  { id, command, payload }
//   响应  { id, result } 或 { id, error, code }
//   进度  { id, type: 'progress', progress, bytes }
//   启动  { type: 'boot', loaded, total } → { type: 'ready' } 或 { type: 'bootError' }
//
// 产物分块由本 worker 内部消化：WASM 回调给出块，写进接收端后立刻调
// streamAck 确认。这条 ACK 不是优化——WASM 侧会一直等确认才生成下一块，
// 少了它中间产物就堆在 wasm 内存里，50MB 的模块加一份未落盘的产物足以让
// 浏览器直接杀掉标签页。ACK 不经过主线程，是因为主线程此时无事可做，
// 绕一圈只会多一次消息投递延迟。
//
// WASM 就绪前到达的请求排队，就绪后按原序重放：主线程不必自己判断 ready，
// 但转换这类重活不能压在队列里等到 50MB 下载完才开始。
//
// wasm_exec.js 只在 worker 里加载：主线程用不到它，而 Go 的 wasm_exec
// 会往全局挂 Go 类，两处各加载一份只会带来两份互不相干的全局状态。
importScripts('wasm_exec.js');

self.addEventListener('error', (event) => {
  console.error('[OFD 工具箱 Worker]', event.error || event.message);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[OFD 工具箱 Worker]', event.reason);
});

/** Go 注册的全局对象。wasm_exec.js 启动后挂在 self 上。 */
let toolbox = null;

/**
 * Go 运行实例。wasm_exec.js 的 run() 会把它挂到 _inst，
 * 而 exports.mem 就是 WebAssembly.Memory——这是唯一能读到线性内存真实
 * 大小的地方，Go 侧拿不到。
 */
let goInstance = null;

/** 当前产物接收端。 */
let sink = null;

/**
 * 当前任务 ID。取消要用它，产物 ACK 也要用它——ACK 按任务 ID 定位，
 * 没有它就无法告诉 WASM「哪一块已经落盘」。
 */
let activeJob = 0;

/** WASM 就绪前排队的消息。 */
const replayQueue = [];

/** 取消类错误的文案。命中即视为用户主动取消，不弹错误提示。 */
const CANCEL_MESSAGES = ['context canceled', '输出流已取消'];

/** 只处理指定命令的命令表；其余按 toolbox 上的同名函数直接调用。 */
const directCommands = new Set(['memoryStats', 'gc']);

// 流式命令到 WASM 函数的映射。转换与水印都产出整个文件、都要分块接收，
// 因此共用同一条流式通道，只是入口函数不同。
const STREAM_COMMANDS = {
  convert: 'startConvert',
  watermark: 'applyWatermark',
  merge: 'mergeDocuments',
  preserve: 'preserveApply',
};


/**
 * wasmLinearBytes 返回线性内存当前保留的字节数。
 *
 * Go 只增长线性内存、不缩小，所以该值单调不减，反映浏览器实际占用的
 * 地址空间。与 Go 的存活堆对照可以看出 GC 后仍被保留的空闲空间。
 */
function wasmLinearBytes() {
  try {
    const memory = goInstance && goInstance._inst && goInstance._inst.exports.mem;
    return memory && memory.buffer ? memory.buffer.byteLength : 0;
  } catch (_) {
    return 0;
  }
}

// ——— 产物接收 ———

/**
 * 创建一个产物接收端。
 *
 * 不使用 File System Access API：那个 picker 必须在用户手势内调用，
 * 而 worker 里没有手势。真要省内存，正确做法是主线程先拿到文件句柄再把
 * handle 传进来，那是后续优化，当前先把分块累加到 Blob 这条路走通。
 */
function createSink(suggestedName) {
  const chunks = [];
  return {
    name: suggestedName,
    size: 0,
    write(chunk) {
      chunks.push(chunk);
      this.size += chunk.byteLength;
    },
    finish() {
      return new Blob(chunks);
    },
  };
}

/**
 * 处理 WASM 下发的一个产物分块。
 *
 * 写入失败也要回 ACK（带上错误），否则 WASM 会一直等下去而不是报错。
 */
function handleChunk(jobID, chunk, sequence) {
  let failure = '';
  if (!sink) {
    failure = '产物接收端未就绪';
  } else {
    try {
      sink.write(chunk);
    } catch (error) {
      failure = `写入失败：${error.message}`;
    }
  }
  // 成功时第三个数传 undefined 而不是空串：空串在语义上更像一条错误消息。
  toolbox.streamAck(jobID, sequence, failure || undefined);
}

// ——— 命令分发 ———

/** 处理一条消息。 */
function dispatch(event) {
  const message = event.data;
  if (!message || message.type === 'chunk' || message.type === 'ack') return;

  if (message.command === 'cancel') {
    if (activeJob && toolbox) toolbox.cancelJob(activeJob);
    postMessage({ id: message.id, result: { cancelled: true } });
    return;
  }

  if (!toolbox) {
    postMessage({ id: message.id, error: 'WASM 尚未初始化完成', code: 'not_ready' });
    return;
  }

  if (STREAM_COMMANDS[message.command]) {
    runConvert(message);
    return;
  }

  if (directCommands.has(message.command)) {
    postMessage({ id: message.id, result: toolbox[message.command](wasmLinearBytes()) });
    return;
  }

  const fn = toolbox[message.command];
  if (typeof fn !== 'function') {
    postMessage({ id: message.id, error: `未知命令 ${message.command}`, code: 'unknown_command' });
    return;
  }
  try {
    postMessage({ id: message.id, result: fn(...(message.args || [])) });
  } catch (error) {
    postMessage({ id: message.id, error: String((error && error.message) || error), code: 'failed' });
  }
}

self.onmessage = (event) => {
  // 取消不排队：WASM 没就绪时本来也没有可取消的东西。
  if (!toolbox && event.data && event.data.command !== 'cancel') {
    replayQueue.push(event);
    return;
  }
  dispatch(event);
};

/** 启动一次流式任务，把进度与产物接回主线程。 */
async function runConvert(message) {
  const { id, payload } = message;
  const entry = STREAM_COMMANDS[message.command];
  activeJob = payload.jobId || id;
  sink = createSink(payload.suggestedName || 'output');

  const request = { ...payload, jobId: activeJob, streamId: activeJob };
  try {
    const result = await toolbox[entry](
      request,
      (chunk, sequence) => handleChunk(activeJob, chunk, sequence),
      (progress) => postMessage({ id, type: 'progress', progress, bytes: sink.size }),
    );
    // 参数校验失败是同步返回 {error} 而不是 reject（计划还没建起来，
    // 谈不上有任务在跑）。不在这里拦住的话，它会当成成功结果往下传，
    // 主线程拿到一个空 blob，最终报出"文档数据为空"这种跟原因毫无关系的错。
    if (result && typeof result.error === 'string') {
      postMessage({ id, error: result.error, code: 'failed' });
      return;
    }
    postMessage({ id, type: 'done', result: { ...result, blob: sink.finish() } });
  } catch (error) {
    const text = String((error && error.message) || error);
    const cancelled = CANCEL_MESSAGES.some((item) => text.includes(item));
    postMessage({ id, error: text, code: cancelled ? 'cancelled' : 'failed' });
  } finally {
    activeJob = 0;
    sink = null;
  }
}

// ——— 初始化 ———

/**
 * 加载并启动 WASM。
 *
 * 用 fetch 而不是让 wasm_exec.js 自己发请求：前者能读 content-length 报下载
 * 进度。50MB 的文件不报进度，页面看起来就像卡死了。
 */
async function boot() {
  const go = new Go();
  goInstance = go;

  const response = await fetch('toolbox.wasm');
  if (!response.ok) throw new Error(`加载 WASM 失败：HTTP ${response.status}`);

  const total = Number(response.headers.get('content-length')) || 0;
  let bytes;

  if (response.body && typeof response.body.getReader === 'function' && total > 0) {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      postMessage({ type: 'boot', loaded: received, total });
    }
    bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
    postMessage({ type: 'boot', loaded: bytes.byteLength, total: bytes.byteLength });
  }

  // run() 要的是 WebAssembly.Instance 而不是字节数组，因此这里自己
  // instantiate 而不是用 instantiateStreaming：后者需要响应带
  // application/wasm，而静态服务器未必配置；同时它也不给下载进度。
  let instance;
  try {
    ({ instance } = await WebAssembly.instantiate(bytes, go.importObject));
  } catch (error) {
    throw new Error(`实例化 WASM 失败：${error.message}`);
  }

  // run() 不返回：Go 侧主函数 select{} 永不结束，promise 到实例退出才
  // settle。因此不能 await 它，要另等 API 注册完成。
  go.run(instance).catch((error) => {
    postMessage({ type: 'bootError', error: `引擎异常退出：${error.message}` });
  });

  // Go 的 init 注册完 main 后才会把 toolbox 挂上。轮询到它出现为止。
  const waitForAPI = () => {
    if (self.toolbox) {
      toolbox = self.toolbox;
      self.onmessage = dispatch;
      postMessage({ type: 'ready' });
      while (replayQueue.length) dispatch({ data: replayQueue.shift() });
      return;
    }
    setTimeout(waitForAPI, 0);
  };
  waitForAPI();
}

boot().catch((error) => {
  postMessage({ type: 'bootError', error: String((error && error.message) || error) });
});
