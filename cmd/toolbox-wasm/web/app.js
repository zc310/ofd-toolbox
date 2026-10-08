// OFD 工具箱前端。
//
// 结构上分三层：
//   1. Worker 桥接（createWorker/call/convert）——所有 WASM 调用都走这里，
//      主线程只处理 DOM。
//   2. 文件与选项状态（state）——一次载入，全 Tab 复用。
//   3. 渲染（render*）——按 Tab 更新 DOM，不做业务判断。
//
// 业务规则集中在两个地方：capabilities 决定哪些选项可见，
// optionSchema 决定每个目标格式下参数面板长什么样。前端不硬编码格式名，
// 库侧增删格式时界面自动跟随。

/** 单次请求 ID。 */
let requestID = 1;

/**
 * worker 句柄。
 *
 * 在 Worker 构造时创建，而不是等某次调用时再创建：所有命令都要经过它，
 * 延迟创建会让第一个请求与 ready 等待之间出现竞态。
 */
let worker = null;

/**
 * 把 worker 挂到 window 上。
 *
 * 调试与自动化测试都要绕过页面逻辑直接问引擎：排查某项能力是不是 WASM 侧
 * 的问题、或者批量验证协议时，走 window.__toolboxWorker 比在页面里点一遍快得多。
 */
globalThis.__toolboxWorker = () => worker;

/** 状态。切换 Tab 时保留，切换文件时按需重算。 */
const state = {
  /** files 是文件队列，每项含 File 与派生信息。 */
  files: [],
  /** selectedID 是当前选中的文件 ID。 */
  selectedID: 0,
  /** doc 是当前文件在 WASM 侧的文档句柄返回值。 */
  doc: null,
  /** target 是当前选中的目标格式名。 */
  target: '',
  /** options 是当前参数取值。 */
  options: {},
  /** capabilities 是 WASM 下发的能力清单。 */
  capabilities: null,
  /** result 是最近一次转换的产物。 */
  result: null,
  /** tab 是当前工具页。 */
  tab: 'convert',
  /** results 缓存各工具最近一次的结果，切 Tab 时不必重算。 */
  results: {},
  /** issueFilter 是校验报告的当前筛选条件。 */
  issueFilter: { severity: '', clause: '', text: '' },
  /** analyzeSection 是分析 Tab 当前展开的子面板。 */
  analyzeSection: 'tree',
  /** treeCollapsed 记住包目录树里被折叠的节点路径。 */
  treeCollapsed: new Set(),
  /** invoiceDetailAll 为真时发票明细表展开全部行。 */
  invoiceDetailAll: false,
  /** watermarkPages 是水印作用的页码集合；null 表示全部页面。 */
  watermarkPages: null,
  /** watermarkInventory 是当前文档已有的水印清单。 */
  watermarkInventory: [],
  /** watermarkResult 是最近一次水印操作的产物。 */
  watermarkResult: null,
  /** fallbackFontCount 是当前已注册的回退字体族数，用于判断预览是否会缺字。 */
  fallbackFontCount: 0,
  /** mergeInputs 是合并的输入文件 ID 列表，顺序即合并顺序。 */
  mergeInputs: [],
  /** mergeResult 是最近一次合并的产物。 */
  mergeResult: null,
  /** preserveResult 是最近一次长期保存转换的产物。 */
  preserveResult: null,
  /** preservePlan 是最近一次预检结果，用于判断是否需要先给用户看改动。 */
  preservePlanResult: null,
  /** busy 表示有任务在跑。 */
  busy: false,
  /** nextFileID 是文件 ID 分配器。 */
  nextFileID: 1,
  /** nextJobID 是任务 ID 分配器，与请求 ID 分开：一次转换可能多次发请求，
   *  而取消要指向具体那次任务。 */
  nextJobID: 1,
  /** activeJobID 是当前进行中的任务 ID，取消时用它。 */
  activeJobID: 0,
};

// ——— Worker 桥接 ———

/**
 * 创建 worker。
 *
 * 用经典 worker（不传 type）而不是 module：worker.js 顶层用 importScripts
 * 加载 wasm_exec.js，那是经典 worker 的能力，module worker 里没有。
 * 页面路径用相对地址，与 index.html 同目录，因此从子路径部署也能工作。
 */
function createWorker() {
  worker = new Worker('worker.js');
  return worker;
}
createWorker();

/** 等待 WASM 就绪。 */
const ready = new Promise((resolve, reject) => {
  const handle = (event) => {
    const message = event.data || {};
    if (message.type === 'ready') {
      worker.removeEventListener('message', handle);
      resolve();
    } else if (message.type === 'bootError') {
      worker.removeEventListener('message', handle);
      reject(new Error(message.error));
    }
  };
  worker.addEventListener('message', handle);
});

/** 请求与响应的映射。 */
const pending = new Map();

worker.addEventListener('message', (event) => {
  const message = event.data || {};
  // 流式产物与进度由 convert 自己处理，不走 pending。
  if (message.type === 'chunk' || message.type === 'ack'
      || message.type === 'progress' || message.type === 'done'
      || message.type === 'boot' || message.type === 'ready') {
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) {
    entry.reject(Object.assign(new Error(message.error), { code: message.code }));
    return;
  }
  // binding 的统一约定是"出错时返回 {error: string}"而不是抛异常，
  // 因为跨 postMessage 传不了 Error 实例。这里把它翻成 rejection，
  // 调用方就只需 try/catch 一处，不必每个命令都判 result.error——
  // 漏判的后果是拿 {error: '…'} 当正常结果继续渲染，报错会变成
  // "Cannot read properties of undefined" 这种看不出原因的形式。
  if (message.result && typeof message.result.error === 'string') {
    entry.reject(new Error(message.result.error));
    return;
  }
  entry.resolve(message.result);
});

/** 调用一个 WASM 命令。 */
function call(command, ...args) {
  const id = requestID++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, command, args });
  });
}

/**
 * 启动一次转换。
 *
 * 只关心 progress 与 done/error 三类消息：产物分块由 worker 内部消化并自行
 * 确认，主线程不参与，否则只是多一次消息投递延迟。
 */
function convert(payload, onProgress) {
  const id = requestID++;
  // command 是 worker 侧的路由键，不该混进传给 WASM 的请求对象里。
  const { command = 'convert', ...request } = payload;
  // 注意 jobID 的大小写：请求体里用的是 jobId（worker 与 WASM 读取的键名），
  // 局部变量叫 jobID。写成 { ...request, jobId } 会在运行时抛
  // "jobId is not defined"，而且只在真正发起任务时才暴露。
  const jobID = request.jobId || state.nextJobID++;
  state.activeJobID = jobID;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const cleanup = () => worker.removeEventListener('message', handle);
    const finish = (fn, value) => {
      cleanup();
      state.activeJobID = 0;
      fn(value);
    };
    function handle(event) {
      const message = event.data || {};
      if (message.id !== id) return;
      if (message.type === 'progress') {
        if (onProgress) onProgress(message.progress, message.bytes);
      } else if (message.type === 'done') {
        finish(resolve, message.result);
      } else if (message.error) {
        finish(reject, Object.assign(new Error(message.error), { code: message.code }));
      }
    }
    worker.addEventListener('message', handle);
    worker.postMessage({ id, command, payload: { ...request, jobId: jobID } });
  });
}

// ——— 格式化 ———

/** formatBytes 把字节数格式化为可读字符串。 */
function formatBytes(size) {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size;
  let index = -1;
  do {
    value /= 1024;
    index++;
  } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)} ${units[index]}`;
}

/** extensionOf 取格式的首选扩展名，去掉前导点。 */
function extensionOf(format) {
  const extensions = format.extensions || [];
  return extensions.length ? extensions[0].replace(/^\./, '') : format.name;
}

// ——— 参数面板定义 ———

// 每个目标格式下参数面板的字段描述。显隐由 capabilities 之外的这张表决定：
// 格式的可用性来自库，参数的取舍是产品决定。
//
// 每项的 hint 会同时出现在字段旁和面板底部——前者解释这个字段，
// 后者把 trade-off 集中起来。
const optionSchema = {
  pdf: [],
  png: [
    { key: 'dpi', type: 'select', label: 'DPI', default: 150, options: [
      { value: 96, label: '96 · 屏幕' },
      { value: 150, label: '150 · 常规' },
      { value: 300, label: '300 · 印刷' },
    ], hint: '分辨率越高越清晰，文件也越大。' },
    backgroundOption(),
  ],
  jpeg: [
    { key: 'dpi', type: 'select', label: 'DPI', default: 150, options: [
      { value: 96, label: '96 · 屏幕' },
      { value: 150, label: '150 · 常规' },
      { value: 300, label: '300 · 印刷' },
    ], hint: '分辨率越高越清晰，文件也越大。' },
    backgroundOption('JPG 不支持透明背景，选择透明时按白色处理。'),
  ],
  tiff: [
    { key: 'dpi', type: 'select', label: 'DPI', default: 150, options: [
      { value: 96, label: '96 · 屏幕' },
      { value: 150, label: '150 · 常规' },
      { value: 300, label: '300 · 印刷' },
    ], hint: '多页 TIFF 打包为 ZIP。' },
    backgroundOption(),
  ],
  svg: [],
  html: [
    { key: 'htmlImageFormat', type: 'select', label: '页面图格式', default: 'png', options: [
      { value: 'png', label: 'PNG' },
      { value: 'jpg', label: 'JPG' },
      { value: 'svg', label: 'SVG' },
    ], hint: 'SVG 保留矢量但复杂渐变可能退化为位图。' },
    { key: 'htmlTextLayer', type: 'check', label: '透明文字层', default: true,
      hint: '关闭后文字不可选中、不可在浏览器内查找、不可朗读。' },
  ],
  docx: [
    { key: 'docxTables', type: 'check', label: '识别表格', default: true,
      hint: '按文字位置推断表格，双栏正文与公式排版可能误判。' },
    { key: 'docxImages', type: 'check', label: '内嵌图片', default: true,
      hint: '每页最多 64 张，SVG 等矢量图会被跳过。' },
    { key: 'docxAnnotations', type: 'check', label: '保留批注层文字', default: false,
      hint: '批注承载水印、电子印章等叠加标记。开启后这些文字会混入正文。' },
  ],
  text: [],
  markdown: [
    { key: 'markdownTables', type: 'check', label: '识别表格', default: false,
      hint: '按文字位置推断无边框表格，双栏正文与公式排版可能误判。' },
  ],
};

/** backgroundOption 是图像类输出共用的背景色字段。 */
function backgroundOption(hint) {
  return {
    key: 'background', type: 'select', label: '背景颜色', default: 'transparent',
    options: [
      { value: 'transparent', label: '透明' },
      { value: 'white', label: '白色' },
      { value: 'black', label: '黑色' },
    ],
    hint: hint || '',
  };
}

/** pageRangeOption 是所有格式共有的页面范围字段。 */
const pageRangeOption = {
  key: 'range', type: 'select', label: '导出范围', default: 'all', options: [
    { value: 'all', label: '全部页面' },
    { value: 'custom', label: '自定义…' },
  ],
};

/** 构造某个目标格式下的完整字段列表。 */
function fieldsFor(target) {
  const base = [pageRangeOption];
  const specific = optionSchema[target] || [];
  return base.concat(specific);
}

/** 默认参数取值。 */
function defaultOptions(target) {
  const values = { range: 'all' };
  for (const field of fieldsFor(target)) {
    values[field.key] = field.default;
  }
  return values;
}

// 校验 Tab 的参数。默认值与 validator 自身的默认值一致：网页不传选项时，
// 界面显示的判据应与库默认判据相同。
const validateOptions = {
  mode: 'strict',
  docType: '',
  checkXSD: true,
  scanXML: true,
  checkProfile: true,
  checkDigest: true,
  failOnWarning: false,
};

// 校验选项面板的字段描述。
const validateSchema = [
  { key: 'mode', type: 'select', label: '校验模式', options: [
    { value: 'strict', label: '严格' },
    { value: 'compat', label: '宽松' },
    { value: 'structural', label: '仅结构' },
  ], hint: '严格模式按 GB/T 33190 完整判定；宽松模式容忍历史偏差；仅结构模式只看包结构与 XML。' },
  { key: 'docType', type: 'text', label: '文档类型', placeholder: '留空表示按文件声明判定',
    hint: '可填 OFD-A、OFD-B 等 profile，用于按特定规则预检。' },
  { key: 'checkXSD', type: 'check', label: '校验 XSD 结构', hint: '关闭可显著加快校验，代价是不报结构偏差。' },
  { key: 'scanXML', type: 'check', label: '扫描 XML 引用', hint: '找出未被引用的条目与断链。' },
  { key: 'checkProfile', type: 'check', label: '按 profile 规则校验', hint: '按文档声明的类型应用额外规则。' },
  { key: 'checkDigest', type: 'check', label: '校验签名摘要', hint: '需要读签名文件，大文档上略慢。' },
  { key: 'failOnWarning', type: 'check', label: '警告视为不通过', hint: '仅影响结论状态，不改变问题计数。' },
];

// ——— 渲染：格式卡片 ———

/** renderFormatGrid 画出目标格式卡片，只画 capabilities 里可用的组合。 */
function renderFormatGrid() {
  const grid = document.getElementById('format-grid');
  const caps = state.capabilities;
  grid.replaceChildren();

  if (!caps || !state.selectedSource) {
    grid.append(note('载入文件后显示可用格式。'));
    return;
  }

  const source = state.selectedSource;
  const notice = document.getElementById('unsupported-note');

  if (source.kind === 'needs_tool') {
    notice.hidden = false;
    notice.className = 'notice is-error';
    notice.textContent = `${source.label} 转换需要 ${(source.tools || []).join('、')}，`
      + '纯浏览器环境无法运行。转换请在桌面工具或服务端完成。';
    grid.append(note('该格式在浏览器内不可转换。'));
    return;
  }
  notice.hidden = true;

  const usable = source.targets || [];
  let rendered = 0;
  for (const name of usable) {
    const format = caps.outputs.find(item => item.name === name);
    if (!format) continue;
    const field = fieldsFor(name);
    const supportsRange = name === 'pdf'
      || name === 'png' || name === 'jpeg' || name === 'svg';
    grid.append(formatCard(format, supportsRange));
    rendered++;
  }
  if (!rendered) {
    grid.append(note('该输入没有可用的目标格式。'));
  }
}

/** formatCard 画一张目标格式卡片。 */
function formatCard(format, supportsRange) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'format-card';
  card.setAttribute('role', 'radio');
  const active = state.target === format.name;
  card.setAttribute('aria-checked', active ? 'true' : 'false');
  if (active) card.classList.add('is-active');

  const name = document.createElement('span');
  name.className = 'format-name';
  name.textContent = format.label;

  const ext = document.createElement('span');
  ext.className = 'format-ext';
  ext.textContent = `.${extensionOf(format)} · ${format.kind === 'image' ? '逐页输出' : '单文件'}`;

  card.append(name, ext);
  card.addEventListener('click', () => {
    if (state.target === format.name) return;
    state.target = format.name;
    state.options = defaultOptions(format.name);
    renderFormatGrid();
    renderOptions();
  });
  return card;
}

// ——— 渲染：参数面板 ———

/** renderOptions 按当前目标格式画参数面板。 */
function renderOptions() {
  const panel = document.getElementById('options');
  panel.replaceChildren();

  if (!state.target) {
    panel.append(note('选择目标格式后显示参数。'));
    return;
  }
  const format = state.capabilities.outputs.find(item => item.name === state.target);
  const fields = fieldsFor(state.target);

  for (const field of fields) {
    panel.append(optionField(field, format));
  }


  // 页面范围的自定义输入跟在范围选择后面，隐藏时保持占位以免面板跳动。
  if (state.options.range === 'custom') {
    const wrap = document.createElement('div');
    wrap.className = 'option';
    const label = document.createElement('label');
    label.htmlFor = 'range-custom';
    label.textContent = '页码';
    const input = document.createElement('input');
    input.id = 'range-custom';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.placeholder = '例如：1-3,5';
    input.value = state.options.rangeValue || '';
    input.addEventListener('input', () => {
      state.options.rangeValue = input.value;
    });
    const hint = document.createElement('p');
    hint.className = 'option-hint';
    hint.textContent = '页码从 1 开始，可用区间与逗号组合。';
    wrap.append(label, input, hint);
    panel.append(wrap);
  }

  panel.append(optionFooter(format));

  // 开始按钮放在参数面板里：格式、参数和动作在同一处视线内，
  // 不必让用户先看参数再往回找按钮。
  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  actions.style.marginTop = '12px';
  const start = actionButton('开始转换', runConvert);
  start.id = 'convert-start';
  start.disabled = !state.selectedSource || !state.target;
  actions.append(start);
  panel.append(actions);
}

/** optionField 画一个参数字段。 */
function optionField(field, format) {
  const wrap = document.createElement('div');
  wrap.className = 'option';

  if (field.type === 'check') {
    const label = document.createElement('label');
    label.className = 'option-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(state.options[field.key]);
    input.addEventListener('change', () => {
      state.options[field.key] = input.checked;
    });
    const text = document.createElement('span');
    text.textContent = field.label;
    label.append(input, text);
    wrap.append(label);
    if (field.hint) wrap.append(hintNode(field.hint));
    return wrap;
  }

  const label = document.createElement('label');
  label.htmlFor = `option-${field.key}`;
  label.textContent = field.label;

  const select = document.createElement('select');
  select.id = `option-${field.key}`;
  for (const item of field.options) {
    const option = document.createElement('option');
    option.value = String(item.value);
    option.textContent = item.label;
    if (String(state.options[field.key]) === String(item.value)) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const raw = select.value;
    const matched = field.options.find(item => String(item.value) === raw);
    state.options[field.key] = matched ? matched.value : raw;
    // 范围从预设切到自定义时立刻显示页码输入框。
    if (field.key === 'range') renderOptions();
  });

  wrap.append(label, select);
  if (field.hint) wrap.append(hintNode(field.hint));
  return wrap;
}

/** hintNode 造一条字段说明。 */
function hintNode(text) {
  const node = document.createElement('p');
  node.className = 'option-hint';
  node.textContent = text;
  return node;
}

/** optionFooter 汇总当前格式的参数说明。 */
function optionFooter(format) {
  const foot = document.createElement('div');
  foot.className = 'option-foot';
  const notes = [];

  if (format) {
    if (format.name === 'pdf') {
      notes.push('PDF 为矢量输出并保持页面物理尺寸，不使用 DPI。');
    }
    if (format.name === 'text' || format.name === 'markdown') {
      notes.push('文本类输出没有页面像素，不使用 DPI 与背景颜色。');
    }
    if (format.kind === 'image') {
      notes.push('逐页输出：多页结果打包为 ZIP，单页直接给出图片。');
    }
  }
  notes.push('本工具不保证转换结果适用于特定业务、法律与合规场景。');
  foot.textContent = notes.join(' ');
  return foot;
}

// ——— 渲染：文件列表 ———

/** renderFiles 画文件队列。 */
function renderFiles() {
  const list = document.getElementById('file-list');
  const empty = document.getElementById('file-empty');
  list.replaceChildren();
  empty.hidden = state.files.length > 0;

  for (const file of state.files) {
    list.append(fileItem(file));
  }
}

/** fileItem 画一个文件卡片。 */
function fileItem(file) {
  const item = document.createElement('li');
  item.className = 'file-item';
  item.tabIndex = 0;
  if (file.id === state.selectedID) item.classList.add('is-selected');
  if (file.state === 'failed') item.classList.add('is-failed');

  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = file.name;
  name.title = file.name;

  const meta = document.createElement('div');
  meta.className = 'file-meta';
  meta.append(stateBadge(file));
  meta.append(metaText(formatBytes(file.size)));
  if (file.doc) meta.append(metaText(`${file.doc.pageCount} 页`));
  if (file.doc && file.doc.stats) {
    meta.append(metaText(`${file.doc.stats.signatures} 个签名`));
  }
  if (file.error) meta.append(metaText(file.error));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'file-remove';
  remove.textContent = '✕';
  remove.title = '移除';
  remove.setAttribute('aria-label', `移除 ${file.name}`);
  // 阻止冒泡到整个条目：否则点"移除"会先选中它再删掉。
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    removeFile(file.id);
  });

  item.append(name, meta, remove);
  item.addEventListener('click', () => selectFile(file.id));
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectFile(file.id);
    }
  });
  return item;
}

/**
 * removeFile 从队列里移除一个文件。
 *
 * 必须同时关掉 WASM 侧的文档句柄：线性内存只增不减，句柄留着就是白占。
 * 被移除的如果是当前选中文档，还要把依赖它的面板复位——校验报告、分析报告、
 * 合并输入都指向那个已经不存在的文档。
 */
async function removeFile(id) {
  const index = state.files.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [file] = state.files.splice(index, 1);

  if (file.doc) {
    await call('closeDocument', file.doc.id).catch(() => {});
    file.doc = null;
  }
  // 合并输入按文件 ID 记录，去掉文件后必须同步，否则会指向不存在的输入。
  state.mergeInputs = state.mergeInputs.filter((item) => item !== id);

  const wasSelected = state.selectedID === id;
  if (wasSelected) {
    // 先清干净，下面的 selectFile 才不会去关一个已经关掉的句柄。
    state.selectedID = 0;
    state.doc = null;
    state.results = {};
    state.target = '';
    state.options = {};
    state.watermarkResult = null;
    state.mergeResult = null;
  }

  renderFiles();

  if (wasSelected) {
    if (state.files.length) {
      // 自动选中相邻的一个，用户不用再点一次卡片。
      const next = state.files[Math.min(index, state.files.length - 1)];
      await selectFile(next.id);
    } else {
      state.selectedSource = null;
      renderFormatGrid();
      renderOptions();
      renderSourceNote();
      renderPreview();
      resetValidatePanel();
      resetAnalyzePanel();
      resetInvoicePanel();
      resetWatermarkPanel();
      resetMergePanel();
    }
  } else if (state.tab === 'merge') {
    // 没选中这个文件，但合并面板列着它，重画一次去掉。
    renderMergeInputs();
  }
}

/** stateBadge 画文件状态标记。 */
function stateBadge(file) {
  const badge = document.createElement('span');
  badge.className = 'file-state';
  if (file.state === 'loading') {
    badge.classList.add('is-busy');
    badge.textContent = '解析中';
  } else if (file.state === 'failed') {
    badge.classList.add('is-error');
    badge.textContent = '失败';
  } else if (file.state === 'ready') {
    badge.classList.add('is-ok');
    badge.textContent = '就绪';
  } else {
    badge.textContent = '待处理';
  }
  return badge;
}

function metaText(text) {
  return document.createTextNode(text);
}

// ——— 文件载入 ———

/** selectFile 选中一个文件并载入 WASM。 */
async function selectFile(id) {
  const file = state.files.find(item => item.id === id);
  if (!file) return;
  // 已经选中且已就绪，无需重做。
  if (state.selectedID === id && file.state === 'ready') return;

  // 关掉当前打开的文档：WASM 线性内存只增不减，不关会一路累积。
  // 关掉之后必须把 file.doc 清空——那是 WASM 侧的文档 ID，句柄没了这个
  // ID 就失效，留着会让"切回上一个文件"拿着已关闭的句柄去渲染，表现为
  // 预览空白或报"文档未打开"。
  //
  // 比较的是文件 ID 而不是文档 ID：state.doc.id 来自 WASM，与队列里的
  // 文件 ID 是两套编号，拿它们互相比迟早碰上数字撞上而误判。
  const previousID = state.selectedID;
  const previous = state.files.find(item => item.id === previousID);
  if (previous && previous.doc && previousID !== id) {
    const handle = previous.doc.id;
    await call('closeDocument', handle).catch(() => {});
    previous.doc = null;
    previous.state = 'pending';
  }

  state.selectedID = id;
  state.result = null;
  state.results = {};
  state.issueFilter = { severity: '', clause: '', text: '' };
  state.analyzeSection = 'tree';
  state.treeCollapsed = new Set();
  state.invoiceDetailAll = false;
  state.watermarkPages = null;
  state.watermarkInventory = [];
  state.watermarkResult = null;
  state.mergeResult = null;
  state.preserveResult = null;
  state.preservePlanResult = null;
  for (const key of Object.keys(loadedSections)) delete loadedSections[key];
  document.getElementById('result-panel').hidden = true;

  if (file.state === 'failed') {
    state.selectedSource = null;
    state.doc = null;
    renderFiles();
    renderFormatGrid();
    return;
  }

  // 只有 OFD 需要（也才能）解析成文档句柄：openDocument 走的是 OFD 阅读器，
  // 对 PDF/图片会报 "zip: not a valid zip file"。这类输入不需要句柄，
  // 转换时把原始字节直接交给 converter 即可。
  const declared = sourceOf(file);
  const needsOpen = !declared || declared.name === 'ofd';
  if (needsOpen && !file.doc) {
    file.state = 'loading';
    renderFiles();
    try {
      const buffer = await file.file.arrayBuffer();
      const doc = await call('openDocument', new Uint8Array(buffer), file.name);
      file.doc = doc;
      file.state = 'ready';
    } catch (error) {
      file.state = 'failed';
      file.error = error.message;
    }
  } else if (!file.doc) {
    file.state = 'ready';
  }

  // 有没有文档句柄就是"是不是 OFD"的判据：openDocument 只对 OFD 成功。
  // 扩展名不认识的文件也是靠打开成功来认定的。
  const isOFD = Boolean(file.doc);
  const source = declared
    || (isOFD && state.capabilities
      ? state.capabilities.inputs.find((input) => input.name === 'ofd') : null);
  state.doc = isOFD ? file.doc : null;
  state.fallbackFontCount = (file.doc && file.doc.fallbackFonts) || 0;
  state.selectedSource = source;
  // 换文件时重置目标格式：上一个文件可用的组合未必对这个也可用。
  state.target = '';
  state.options = {};

  renderFiles();
  renderFormatGrid();
  renderOptions();
  renderSourceNote();
  renderPreview();
  // 换文件要把校验面板重置：报告属于上一个文档，留着会让用户对着
  // 旧报告判断新文件。
  resetValidatePanel();
  resetAnalyzePanel();
  resetInvoicePanel();
  resetWatermarkPanel();
  resetMergePanel();
  resetPreservePanel();
  // 字体面板开着时同步刷新：它上半部分列的是"当前文档的字体"，
  // 换了文件还留着上一个文档的清单，会让人按错字体去做决定。
  const fontPanel = document.getElementById('font-panel');
  if (fontPanel && !fontPanel.hidden) refreshFontPanel();
}

/** resetPreservePanel 重置长期保存面板。 */
function resetPreservePanel() {
  const host = document.getElementById('preserve');
  if (!host) return;
  delete host.dataset.built;
  if (state.tab === 'preserve') {
    buildPreservePanel(host);
  } else {
    host.replaceChildren(note('载入 OFD 后先预检，再执行长期保存转换。'));
  }
}

/** resetMergePanel 重置合并面板。 */
function resetMergePanel() {
  const host = document.getElementById('merge');
  if (!host) return;
  delete host.dataset.built;
  if (state.tab === 'merge') {
    buildMergePanel(host);
  } else {
    host.replaceChildren(note('把多个 OFD 加入队列后即可合并。'));
  }
}

/** resetWatermarkPanel 重置水印面板。 */
function resetWatermarkPanel() {
  const host = document.getElementById('watermark');
  if (!host) return;
  delete host.dataset.built;
  if (state.tab === 'watermark') {
    buildWatermarkPanel(host);
  } else {
    host.replaceChildren(note('载入 OFD 后配置水印。'));
  }
}

/** resetInvoicePanel 重置发票面板。 */
function resetInvoicePanel() {
  const host = document.getElementById('invoice');
  if (!host) return;
  delete host.dataset.built;
  if (state.tab === 'invoice') {
    buildInvoicePanel(host);
  } else {
    host.replaceChildren(note('载入发票 OFD 后点击「开始抽取」。'));
  }
}

/** resetAnalyzePanel 重置分析面板。 */
function resetAnalyzePanel() {
  const host = document.getElementById('analyze');
  if (!host) return;
  delete host.dataset.built;
  analyzeReportID = 0;
  if (state.tab === 'analyze') {
    buildAnalyzePanel(host);
  } else {
    host.replaceChildren(note('载入 OFD 后点击「开始分析」。'));
  }
}

/** sourceOf 从能力清单里找出该文件对应的输入格式描述。 */
function sourceOf(file) {
  const caps = state.capabilities;
  if (!caps) return null;
  const lower = file.name.toLowerCase();
  const byExtension = caps.inputs.find((input) =>
    (input.extensions || []).some(ext => lower.endsWith(ext)));
  if (byExtension) return byExtension;
  // 扩展名不认识时按内容判断的结果兜底：OFD 与 PDF 的字节已在打开时读过。
  return file.doc ? caps.inputs.find(input => input.name === 'ofd') : null;
}

/** renderSourceNote 更新来源说明。 */
function renderSourceNote() {
  const node = document.getElementById('convert-source');
  const source = state.selectedSource;
  if (!source) {
    node.textContent = '载入文件后可选择目标格式。';
    return;
  }
  const doc = state.doc;
  const file = state.files.find((item) => item.id === state.selectedID);
  const size = doc
    ? ` · ${doc.pageCount} 页 · ${formatBytes(doc.size)}`
    : (file ? ` · ${formatBytes(file.size)}` : '');
  node.textContent = `来源：${source.label}${size}`;
}

// ——— 预览 ———

/** renderPreview 画前几页缩略图。 */
async function renderPreview() {
  const strip = document.getElementById('preview-strip');
  strip.replaceChildren();
  if (!state.doc) {
    // PDF/图片这类输入没有 OFD 文档句柄，自然也没有页面预览。
    // 说清楚"不用等预览"，而不是留一片空白让人以为还在加载。
    if (state.selectedSource) strip.append(note('该格式没有页面预览，直接选目标格式转换即可。'));
    return;
  }

  const limit = Math.min(state.doc.pageCount, 12);
  const indices = Array.from({ length: limit }, (_, index) => index);
  strip.append(note('正在渲染预览…'));

  // 缺字体的警告放在预览上方、独立一行：空白预览最容易被当成"文件坏了"，
  // 说清楚是缺字体并给出下一步。
  renderPreviewWarning();

  try {
    const thumbs = await call('renderThumbnails', state.doc.id, indices, {});
    strip.replaceChildren();
    for (const thumb of thumbs.thumbs) {
      strip.append(previewPage(thumb, () => showPageLarge(thumb.page)));
    }
    if (state.doc.pageCount > limit) {
      strip.append(note(`另有 ${state.doc.pageCount - limit} 页`));
    }
  } catch (error) {
    strip.replaceChildren(note(`预览失败：${error.message}`));
  }
}

/** renderPreviewWarning 把缺字体提示画到预览上方独立的一行。 */
function renderPreviewWarning() {
  const host = document.getElementById('preview-warning');
  if (!host) return;
  host.replaceChildren();
  const warning = missingFontWarning();
  if (warning) host.append(warning);
}

/**
 * missingFontWarning 在文档缺字体且没注册回退时给出提示。
 *
 * 只提示"有字体没内嵌"是不够的：用户看到的是一张空白页，得同时告诉他
 * 点哪里能解决，否则这条提示只是在陈述一个他无法处理的事实。
 */
function missingFontWarning() {
  const fonts = (state.doc && state.doc.fonts) || [];
  const missing = fonts.filter((font) => !font.embedded).length;
  if (!missing || state.fallbackFontCount > 0) return null;
  const warn = document.createElement('div');
  warn.className = 'notice is-error';
  warn.id = 'font-missing-note';
  warn.append(document.createTextNode(
    `该文档有 ${missing} 个字体未内嵌，浏览器里没有系统字体，预览可能空白。`));
  const wrap = document.createElement('div');
  wrap.className = 'notice-actions';
  const open = actionButton('选择字体', () => {
    const panel = document.getElementById('font-panel');
    panel.hidden = false;
    refreshFontPanel();
  });
  open.id = 'font-missing-action';
  wrap.append(open);
  warn.append(wrap);
  return warn;
}

/** previewPage 画一页缩略图。 */
function previewPage(thumb, onOpen) {
  return previewThumb(
    blobURL(new Blob([thumb.data], { type: 'image/png' })),
    `第 ${thumb.page + 1} 页`,
    thumb.page + 1,
    onOpen,
  );
}

/**
 * previewThumb 画一个预览缩略图。
 *
 * onOpen 非空时缩略图可点击，点开看大图。传回调而不是让这里自己取数据：
 * 转换的文档还开着，可以按需重新渲染高清页；水印预览的文档在渲染完就关了，
 * 只能复用已经拿到的那张图，两者的取图方式不同。
 */
function previewThumb(src, alt, label, onOpen) {
  const wrap = document.createElement('div');
  wrap.className = 'preview-page';
  const img = document.createElement('img');
  img.alt = alt;
  img.src = src;
  const caption = document.createElement('span');
  caption.textContent = label;
  wrap.append(img, caption);
  if (onOpen) {
    wrap.classList.add('is-clickable');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('aria-label', `${alt}，点击看大图`);
    wrap.addEventListener('click', onOpen);
    wrap.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen();
      }
    });
  }
  return wrap;
}

/** openImageViewer 用大图查看器展示一张图。 */
function openImageViewer(src, caption) {
  const dialog = document.getElementById('image-viewer');
  const img = document.getElementById('image-viewer-img');
  const label = document.getElementById('image-viewer-caption');
  if (!dialog || !img) return;
  img.src = src;
  if (label) label.textContent = caption || '预览';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/**
 * showPageLarge 按需重新渲染一页来展示大图。
 *
 * 缩略图是 36 DPI，直接放大只会看到一团糊；点开时按高 DPI 重渲染一张，
 * 才是"看大图"该有的样子。
 */
async function showPageLarge(page) {
  if (!state.doc) return;
  try {
    const rendered = await call('renderPage', state.doc.id, page,
      { dpi: 150, background: 'white' });
    openImageViewer(
      blobURL(new Blob([rendered.data], { type: 'image/png' })),
      `第 ${page + 1} 页`,
    );
  } catch (error) {
    showNotice(`打开大图失败：${error.message}`, true);
  }
}

/** blobURL 生成对象 URL 并登记，供收尾时统一释放。 */
const objectURLs = [];
function blobURL(blob) {
  const url = URL.createObjectURL(blob);
  objectURLs.push(url);
  return url;
}

/** releaseObjectURLs 释放所有已登记的对象 URL。 */
function releaseObjectURLs() {
  while (objectURLs.length) URL.revokeObjectURL(objectURLs.pop());
}

// ——— 转换 ———

/** runConvert 执行一次转换。 */
async function runConvert() {
  if (!state.target || state.busy) return;
  const file = state.files.find((item) => item.id === state.selectedID);
  if (!file || !state.selectedSource) return;

  const format = state.capabilities.outputs.find(item => item.name === state.target);
  const rangeSpec = state.options.range === 'custom'
    ? (state.options.rangeValue || '').trim()
    : '';

  // 文档类编码器只接受全部页面或单页，自定义范围在这些格式上没有意义：
  // 静默忽略范围比报错更难察觉，因此提前说明。
  if (rangeSpec && !supportsRange(format.name)) {
    showNotice(`${format.label} 不支持自定义页范围，已按全部页面导出。`);
  }

  state.busy = true;
  const panel = document.getElementById('result-panel');
  panel.hidden = true;
  setTask('转换中', 0, true);

  const started = performance.now();
  try {
    const payload = {
      from: state.selectedSource.name,
      to: state.target,
      range: rangeSpec,
      dpi: state.options.dpi,
      background: state.options.background,
      markdownTables: state.options.markdownTables,
      docxTables: state.options.docxTables,
      docxImages: state.options.docxImages,
      docxAnnotations: state.options.docxAnnotations,
      htmlTextLayer: state.options.htmlTextLayer,
      htmlImageFormat: state.options.htmlImageFormat,
      suggestedName: suggestName(file.name, format),
    };
    if (state.doc) {
      payload.documentId = state.doc.id;
    } else {
      // 非 OFD 输入没有文档句柄，直接把字节送进去。
      payload.data = new Uint8Array(await file.file.arrayBuffer());
    }
    const result = await convert(payload, (progress, bytes) => {
      const detail = progress.pages > 0
        ? `第 ${Math.min(progress.page + 1, progress.pages)}/${progress.pages} 页`
        : phaseLabel(progress.phase);
      const suffix = bytes ? ` · ${formatBytes(bytes)}` : '';
      setTask('转换中', ratioOf(progress), progress.pages === 0, detail + suffix);
    });

    const elapsed = (performance.now() - started) / 1000;
    state.result = {
      name: suggestName(file.name, format),
      blob: result.blob,
      size: result.blob.size,
      pages: result.pages,
      zipped: result.zipped,
      elapsed,
    };
    finishTask('转换完成', `${formatBytes(result.blob.size)} · 用时 ${elapsed.toFixed(1)} 秒`);
    renderResult();
  } catch (error) {
    if (error.code === 'cancelled') {
      finishTask('已取消');
    } else {
      finishTask('转换失败', error.message);
      showNotice(`转换失败：${error.message}`, true);
    }
  } finally {
    state.busy = false;
  }
}

/** supportsRange 判断目标格式是否接受自定义页集合。 */
function supportsRange(name) {
  return name === 'pdf' || name === 'png' || name === 'jpeg' || name === 'svg';
}

/** ratioOf 从进度算出 0 到 1 的比例。 */
function ratioOf(progress) {
  if (progress.phase === 'done') return 1;
  if (!progress.pages) return 0;
  return Math.min(progress.page / progress.pages, 0.99);
}

/** phaseLabel 把阶段名翻译成界面文案。 */
function phaseLabel(phase) {
  if (phase === 'rendering') return '正在渲染';
  if (phase === 'done') return '完成';
  return phase;
}

/** suggestName 由原文件名与目标格式推出产物文件名。 */
function suggestName(source, format) {
  const base = source.replace(/\.[^.]+$/, '') || 'output';
  if (format.name === 'svg') return `${base}.zip`;
  if (format.kind === 'image' && format.name !== 'pdf') return `${base}.${extensionOf(format)}`;
  return `${base}.${extensionOf(format)}`;
}

// ——— 渲染：结果 ———

/** renderResult 画转换结果与操作按钮。 */
function renderResult() {
  const panel = document.getElementById('result-panel');
  const result = state.result;
  panel.replaceChildren();
  panel.hidden = false;

  const head = document.createElement('div');
  head.className = 'result-head';
  const title = document.createElement('strong');
  title.textContent = '产物已生成';
  const meta = document.createElement('span');
  meta.className = 'result-meta';
  const parts = [result.name, formatBytes(result.size), `用时 ${result.elapsed.toFixed(1)} 秒`];
  if (result.pages) parts.push(`${result.pages} 页`);
  if (result.zipped) parts.push('ZIP 打包');
  meta.textContent = parts.join(' · ');
  head.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  actions.append(actionButton('下载产物', () => downloadResult()));
  // OFD 产物可以直接在预览区打开验证，PDF 产物交给浏览器新标签页。
  if (state.target === 'ofd') {
    actions.append(actionButton('预览产物', () => previewResult()));
  }

  panel.append(head, actions);
}

/** actionButton 造一个动作按钮。 */
function actionButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

/** downloadResult 下载产物。 */
function downloadResult() {
  const result = state.result;
  if (!result) return;
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = result.name;
  link.click();
  // 立刻撤销会让部分浏览器的下载中断，因此延后释放。
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** previewResult 把 OFD 产物载入预览。 */
async function previewResult() {
  const result = state.result;
  if (!result) return;
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  try {
    const doc = await call('openDocument', bytes, result.name);
    state.doc = doc;
    state.selectedSource = state.capabilities.inputs.find(input => input.name === 'ofd');
    renderSourceNote();
    renderPreview();
  } catch (error) {
    showNotice(`产物预览失败：${error.message}`, true);
  }
}

// ——— 任务条 ———

/** setTask 更新任务条。indeterminate 为真时进度条走条纹动画。 */
function setTask(label, ratio, indeterminate, detail) {
  const bar = document.getElementById('taskbar');
  bar.hidden = false;
  document.getElementById('task-label').textContent = label;
  document.getElementById('task-detail').textContent = detail || '';
  const fill = document.getElementById('task-fill');
  fill.classList.toggle('is-indeterminate', Boolean(indeterminate));
  fill.style.width = indeterminate ? '' : `${Math.round(ratio * 100)}%`;
  // 取消按钮只在真有任务可取消时出现。用 hidden 而不是 disabled：
  // 任务已经结束还摆着一个"取消"，用户会以为点了能撤掉刚才的结果。
  document.getElementById('task-cancel').hidden = !state.busy;
  document.getElementById('task-download').hidden = label !== '转换完成';
}

/**
 * finishTask 结束一次任务并更新任务条。
 *
 * 必须先清 busy 再调 setTask：反过来写的话，setTask 读到的 busy 还是 true，
 * 取消按钮会停在"可点"状态——任务明明已经结束了。此前每个工具都是这么写的，
 * 所以"完成/失败"之后取消按钮一直亮着。
 */
function finishTask(label, detail) {
  state.busy = false;
  setTask(label, 1, false, detail);
}

/** showNotice 在工作区顶部显示一条提示。 */
function showNotice(text, isError) {
  const node = document.getElementById('unsupported-note');
  node.hidden = false;
  node.className = isError ? 'notice is-error' : 'notice';
  node.textContent = text;
}

/** note 造一条灰色说明文字。 */
function note(text) {
  const node = document.createElement('p');
  node.className = 'hint';
  node.textContent = text;
  return node;
}

// ——— 发票 Tab ———

/**
 * 发票字段的展示分组。
 *
 * 顺序按核对时最常问的顺序排：先看是不是这张票，再看金额，最后才是经手人
 * 与开户行那些平时不看的字段。
 */
const invoiceGroups = [
  { label: '票面信息', fields: [
    { key: 'title', label: '发票标题' },
    { key: 'type', label: '发票类型' },
    { key: 'code', label: '发票代码' },
    { key: 'number', label: '发票号码' },
    // 原样显示：真实发票写的是「2020年08月05日」，按 ISO 解析再格式化
    // 会把解析失败的日期显示成 Invalid Date。
    { key: 'date', label: '开票日期' },
    { key: 'checksum', label: '校验码', mono: true },
    { key: 'machine_number', label: '机器编号', mono: true },
    { key: 'tax_control_code', label: '税控码', mono: true },
    { key: 'total_amount_string', label: '价税合计（大写）' },
  ] },
  { label: '金额', fields: [
    { key: 'amount', label: '不含税金额' },
    { key: 'tax_amount', label: '税额' },
    { key: 'total_amount', label: '价税合计', strong: true },
  ] },
  { label: '经手', fields: [
    { key: 'payee', label: '收款人' },
    { key: 'reviewer', label: '复核人' },
    { key: 'drawer', label: '开票人' },
  ] },
];

/** buildInvoicePanel 搭出发票面板的骨架。 */
function buildInvoicePanel(host) {
  host.replaceChildren();
  host.dataset.built = '1';

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const start = actionButton('开始抽取', runInvoiceExtract);
  start.id = 'invoice-start';
  start.disabled = !state.doc;
  actions.append(start);

  const result = document.createElement('div');
  result.id = 'invoice-result';
  result.className = 'report-host';

  host.append(actions, result, invoiceNote());
}

/** invoiceResultHost 取发票结果宿主，必要时先建面板。 */
function invoiceResultHost() {
  let host = document.getElementById('invoice-result');
  if (host) return host;
  const panel = document.getElementById('invoice');
  if (!panel) return null;
  buildInvoicePanel(panel);
  return document.getElementById('invoice-result');
}

/** invoiceNote 是发票抽取的来源说明。 */
function invoiceNote() {
  const node = document.createElement('p');
  node.className = 'hint';
  node.textContent = '字段取自包内的发票结构化附件；发票标题与价税合计大写'
    + '由页面文字层补齐。抽取结果仅供核对，票面以原件为准。';
  return node;
}

/** runInvoiceExtract 执行抽取并画字段表。 */
async function runInvoiceExtract() {
  if (!state.doc || state.busy) return;
  state.busy = true;
  const host = invoiceResultHost();
  host.replaceChildren(note('正在抽取…'));
  setTask('抽取中', 0, true);

  const started = performance.now();
  try {
    const result = await call('extractInvoice', state.doc.id);
    state.results.invoice = result;
    renderInvoice(result);
    const elapsed = (performance.now() - started) / 1000;
    finishTask('抽取完成', `${elapsed.toFixed(1)} 秒`);
  } catch (error) {
    renderInvoiceError(error.message);
    finishTask('抽取失败');
  } finally {
    state.busy = false;
  }
}

/**
 * renderInvoiceError 画抽取失败。
 *
 * 附件缺失是最常见的失败，原因分两种：该文件确实不是发票，或者确实是发票
 * 但厂商用了别的附件布局。这两者要分开说，否则用户只能自己猜。
 */
function renderInvoiceError(message) {
  const host = invoiceResultHost();
  host.replaceChildren();
  const box = document.createElement('div');
  box.className = 'notice is-error';
  const title = document.createElement('strong');
  title.textContent = '无法抽取发票信息';
  const detail = document.createElement('div');
  detail.textContent = message;
  box.append(title, detail);
  host.append(box);
}

/** renderInvoice 画发票字段表与明细。 */
function renderInvoice(invoice) {
  const host = invoiceResultHost();
  if (!host) return null;
  host.replaceChildren();

  host.append(invoiceHead(invoice));
  for (const group of invoiceGroups) {
    host.append(invoiceFieldGroup(invoice, group));
  }
  host.append(partyGroup('购买方', invoice.buyer));
  host.append(partyGroup('销售方', invoice.seller));
  host.append(detailTable(invoice.details));

  const warnings = (invoice.warnings || []).map((text) => {
    const node = document.createElement('div');
    node.className = 'issue-hint';
    node.textContent = `提示：${text}`;
    return node;
  });
  if (warnings.length) {
    const box = document.createElement('div');
    box.className = 'notice';
    box.append(...warnings);
    host.append(box);
  }

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  actions.append(actionButton('导出 JSON', () => exportInvoiceJSON()));
  actions.append(actionButton('复制到剪贴板', () => copyInvoiceJSON()));
  host.append(actions);
  return host;
}

/** invoiceHead 画头部：票面标题与来源附件。 */
function invoiceHead(invoice) {
  const bar = document.createElement('div');
  bar.className = 'notice is-ok';
  const title = document.createElement('strong');
  title.textContent = invoice.title || '发票信息';
  bar.append(title);
  const detail = document.createElement('div');
  const parts = [];
  if (invoice.source) parts.push(invoice.source);
  if (invoice.attachment) parts.push(`附件 ${invoice.attachment}`);
  detail.textContent = parts.join(' · ');
  bar.append(detail);
  return bar;
}

/** invoiceFieldGroup 画一组字段。 */
function invoiceFieldGroup(invoice, group) {
  const box = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = group.label;
  box.append(title);

  const list = document.createElement('dl');
  list.className = 'kv';
  for (const field of group.fields) {
    const value = invoice[field.key];
    // 金额是十进制字符串而不是数字，这里原样显示：转成 Number 再格式化
    // 会丢掉小数位，财务核对时那个差别是要出事的。
    const dt = document.createElement('dt');
    dt.textContent = field.label;
    const dd = document.createElement('dd');
    if (field.strong) dd.classList.add('is-strong');
    if (field.mono) dd.classList.add('mono');
    dd.textContent = value === undefined || value === null || value === ''
      ? '—' : String(value);
    list.append(dt, dd);
  }
  box.append(list);
  return box;
}

/** partyGroup 画购销双方。 */
function partyGroup(label, party) {
  const box = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = label;
  box.append(title);
  const list = document.createElement('dl');
  list.className = 'kv';
  for (const [key, name] of [['name', '名称'], ['code', '纳税人识别号'],
    ['address', '地址电话'], ['account', '开户行及账号']]) {
    const dt = document.createElement('dt');
    dt.textContent = name;
    const dd = document.createElement('dd');
    dd.textContent = (party && party[key]) || '—';
    list.append(dt, dd);
  }
  box.append(list);
  return box;
}

/** 明细表默认渲染的行数上限。真实发票动辄上百行，一次全渲染既慢又没人逐行看。 */
const invoiceDetailLimit = 20;

/** detailTable 画商品明细。 */
function detailTable(details) {
  const box = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = `商品明细（${details.length} 行）`;
  box.append(title);
  if (!details.length) {
    box.append(note('附件里没有商品明细。'));
    return box;
  }

  const expanded = state.invoiceDetailAll || details.length <= invoiceDetailLimit;
  const shown = expanded ? details : details.slice(0, invoiceDetailLimit);
  box.append(simpleTable(
    ['项目名称', '规格型号', '单位', '数量', '单价', '金额', '税率', '税额'],
    shown.map((row) => [
      row.name || '—', row.model || '—', row.unit || '—',
      row.count || '—', row.price || '—', row.amount || '—',
      row.tax_rate || '—', row.tax_amount || '—',
    ]),
  ));

  if (details.length > invoiceDetailLimit) {
    const more = document.createElement('div');
    more.className = 'tool-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ghost';
    toggle.textContent = expanded
      ? '只看前 20 行' : `展开全部 ${details.length} 行`;
    toggle.addEventListener('click', () => {
      state.invoiceDetailAll = !expanded;
      renderInvoice(state.results.invoice);
    });
    more.append(toggle);
    box.append(more);
  }

  // 明细金额与合计对不上是常见的核算问题，值得在界面上直接点出来。
  // 合计按全部行算，不是按当前显示的行——否则折叠状态下会误报不一致。
  const sum = details.reduce((total, row) => total + (Number(row.amount) || 0), 0);
  const declared = state.results.invoice;
  const declaredTotal = Number(declared && declared.amount) || 0;
  if (declaredTotal && Math.abs(sum - declaredTotal) > 0.01) {
    const notice = document.createElement('div');
    notice.className = 'notice is-error';
    notice.textContent = `明细金额合计 ${sum} 与不含税金额 ${declaredTotal} 不一致。`;
    box.append(notice);
  }
  return box;
}

/** invoiceJSON 生成可导出的 JSON 文本。 */
function invoiceJSON() {
  const source = state.results.invoice || {};
  const { source: fileName, ...rest } = source;
  return JSON.stringify({
    schema: 'ofd-toolbox/invoice',
    extracted_from: fileName,
    invoice: rest,
  }, null, 2);
}

/** exportInvoiceJSON 下载 JSON。 */
function exportInvoiceJSON() {
  if (!state.results.invoice) return;
  const base = (state.results.invoice.source || 'invoice').replace(/\.[^.]+$/, '');
  downloadBlob(new Blob([invoiceJSON()], { type: 'application/json' }),
    `${base}.json`);
}

/** copyInvoiceJSON 复制 JSON 到剪贴板。 */
async function copyInvoiceJSON() {
  if (!state.results.invoice) return;
  try {
    await navigator.clipboard.writeText(invoiceJSON());
    showNotice('已复制到剪贴板。');
  } catch (error) {
    // 剪贴板 API 要 HTTPS 与用户手势，无线环境下多半不可用。
    // 退回让用户自己选：直接显示在页面上比一句"复制失败"有用。
    const pre = document.createElement('pre');
    pre.className = 'copy-fallback';
    pre.textContent = invoiceJSON();
    const host = invoiceResultHost();
    host.append(pre);
    showNotice('剪贴板不可用，JSON 已显示在页面下方，请手动复制。');
  }
}

// ——— 分析 Tab ———

/** analyzeReportID 是当前分析报告的 WASM 侧 ID。 */
let analyzeReportID = 0;

/** analyzeOptions 是分析选项，默认不含包目录树。 */
const analyzeOptions = { tree: true, templates: true, annotations: true, signatures: true };

/**
 * 分析 Tab 的子面板。
 *
 * 一次分析的结果切成几块：概览总是显示，其余按需从 WASM 取。目录树和页
 * 列表对千页文档各有一两百 KB，界面不翻到那一块就不该为它付出解析与渲染。
 */
const analyzeSections = {
  tree: { label: '包结构', countKey: null, hint: 'ZIP 包内的目录与条目' },
  resources: { label: '资源', countKey: 'resources', hint: '字体、图片、绘制参数等资源的定义与使用' },
  pages: { label: '页面', countKey: 'pages', hint: '每页的尺寸、图层数与对象统计' },
  signatures: { label: '签名', countKey: 'signatures', hint: '签名判据与证书链' },
  attachments: { label: '附件', countKey: 'attachments', hint: '包内附件' },
  annotations: { label: '注解', countKey: 'annotations', hint: '页面注解' },
  fileReferences: { label: '文件引用', countKey: 'fileReferences', hint: 'XML 之间��文件引用关系' },
};

/** loadedSections 记录已经取过的章节，避免重复请求。 */
const loadedSections = {};

/** buildAnalyzePanel 搭出分析面板的骨架。 */
function buildAnalyzePanel(host) {
  host.replaceChildren();
  host.dataset.built = '1';

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const start = actionButton('开始分析', runAnalysis);
  start.id = 'analyze-start';
  start.disabled = !state.doc;
  actions.append(start);

  const details = document.createElement('details');
  details.className = 'validate-options';
  const summary = document.createElement('summary');
  summary.textContent = '分析范围';
  const body = document.createElement('div');
  body.className = 'option-body';
  for (const [key, label, hint] of [
    ['tree', '包目录树', '关闭可省内存，但页面上的结构树就取不到。'],
    ['signatures', '签名与证书', '关闭可跳过签名与证书解析。'],
    ['annotations', '注解', '关闭可跳过注解统计。'],
  ]) {
    const wrap = document.createElement('div');
    wrap.className = 'option';
    const labelNode = document.createElement('label');
    labelNode.className = 'option-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = analyzeOptions[key];
    input.addEventListener('change', () => { analyzeOptions[key] = input.checked; });
    const text = document.createElement('span');
    text.textContent = label;
    labelNode.append(input, text);
    wrap.append(labelNode, hintNode(hint));
    body.append(wrap);
  }
  details.append(summary, body);

  const result = document.createElement('div');
  result.id = 'analyze-result';
  result.className = 'report-host';

  host.append(actions, details, result, disclaimerNote());
}

/** analyzeResultHost 取分析结果宿主，必要时先建面板。 */
function analyzeResultHost() {
  let host = document.getElementById('analyze-result');
  if (host) return host;
  const panel = document.getElementById('analyze');
  if (!panel) return null;
  buildAnalyzePanel(panel);
  return document.getElementById('analyze-result');
}

/** runAnalysis 执行分析并画概览。 */
async function runAnalysis() {
  if (!state.doc || state.busy) return;
  state.busy = true;
  const host = analyzeResultHost();
  host.replaceChildren(note('正在分析…'));
  setTask('分析中', 0, true);

  const started = performance.now();
  try {
    const response = await call('analyzeDocument', state.doc.id, { ...analyzeOptions });
    analyzeReportID = response.reportId;
    for (const key of Object.keys(loadedSections)) delete loadedSections[key];
    state.results.analyze = response.report;
    renderAnalysis(response.report);
    const elapsed = (performance.now() - started) / 1000;
    finishTask('分析完成', `${elapsed.toFixed(1)} 秒`);
  } catch (error) {
    host.replaceChildren(note(error.message));
    finishTask('分析失败', error.message);
  } finally {
    state.busy = false;
  }
}

/** renderAnalysis 画分析概览与子面板切换。 */
function renderAnalysis(report) {
  const host = analyzeResultHost();
  if (!host) return null;
  host.replaceChildren();

  host.append(analyzeHead(report));
  host.append(statRow(report));
  host.append(sectionTabs(report));
  host.append(sectionBody(report));
  return host;
}

/** analyzeHead 画头部信息条。 */
function analyzeHead(report) {
  const bar = document.createElement('div');
  bar.className = `notice is-${report.status === 'complete' ? 'ok' : report.status === 'partial' ? 'warn' : 'error'}`;
  const title = document.createElement('strong');
  const label = { complete: '分析完成', partial: '部分完成', failed: '分析失败' };
  title.textContent = label[report.status] || `分析状态：${report.status}`;
  bar.append(title);

  const detail = document.createElement('div');
  const parts = [`${report.input.path || report.input.name} · ${formatBytes(report.input.size)}`];
  if (report.ofd && report.ofd.version) parts.push(`OFD ${report.ofd.version}`);
  if (report.ofd && report.ofd.doc_type) parts.push(report.ofd.doc_type);
  const pkg = report.package || {};
  if (pkg.files) {
    parts.push(`${pkg.files} 个条目`);
    if (pkg.compressed_bytes && pkg.uncompressed_bytes) {
      const ratio = Math.round(pkg.uncompressed_bytes / pkg.compressed_bytes * 100) / 100;
      parts.push(`压缩 ${formatBytes(pkg.compressed_bytes)}`
        + ` → ${formatBytes(pkg.uncompressed_bytes)}（${ratio}×）`);
    }
  }
  detail.textContent = parts.join(' · ');
  bar.append(detail);

  for (const warning of report.warnings || []) {
    const item = document.createElement('div');
    item.className = 'issue-hint';
    item.textContent = `警告：${warning}`;
    bar.append(item);
  }
  for (const error of report.errors || []) {
    const item = document.createElement('div');
    item.className = 'issue-hint';
    item.textContent = `错误：${error}`;
    bar.append(item);
  }
  return bar;
}

/** statRow 画统计卡片行。 */
function statRow(report) {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const summary = report.summary || {};
  const objects = report.objects || {};
  const text = report.text || {};
  const resources = report.resources || {};
  const fonts = resources.fonts || {};

  const cards = [
    ['文档体', summary.document_bodies ?? 0],
    ['页面', summary.pages ?? 0],
    ['对象', objects.total ?? 0],
    ['文字对象', text.objects ?? 0],
    ['文字字符', summary.text_characters ?? 0],
    ['图片', summary.images ?? 0],
    ['字体', summary.fonts ?? 0],
    ['附件', report.counts.attachments ?? 0],
    ['注解', summary.annotations ?? 0],
    ['签名', summary.signatures ?? 0],
  ];
  for (const [label, value] of cards) {
    const card = document.createElement('div');
    card.className = 'stat';
    const number = document.createElement('b');
    number.textContent = String(value);
    const caption = document.createElement('span');
    caption.textContent = label;
    card.append(number, caption);
    row.append(card);
  }

  // 字体嵌入情况单独标出来：文档声明了字体却一份都没内嵌时，
  // 换一台设备打开就可能是另一副字形，这正是用户最该先知道的。
  if (fonts.declared) {
    const card = document.createElement('div');
    card.className = 'stat';
    const number = document.createElement('b');
    number.textContent = `${fonts.embedded ?? 0}/${fonts.declared}`;
    const caption = document.createElement('span');
    caption.textContent = '字体内嵌';
    card.append(number, caption);
    card.title = `声明 ${fonts.declared} 个字体，其中 ${fonts.embedded ?? 0} 个内嵌了字形数据`;
    row.append(card);
  }
  return row;
}

/** sectionTabs 画子面板切换。 */
function sectionTabs(report) {
  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  bar.id = 'analyze-tabs';

  const counts = report.counts || {};
  for (const [name, meta] of Object.entries(analyzeSections)) {
    const count = meta.countKey ? counts[meta.countKey] : null;
    // 包结构没有条目数（要到树上数），其余按数量显示；数量为 0 的
    // 仍然保留按钮，点开给的是"没有签名"这类明确结论，而不是让用户
    // 猜是不是漏了功能。
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.dataset.section = name;
    button.textContent = count === null ? meta.label : `${meta.label}（${count}）`;
    if (state.analyzeSection === name) button.classList.add('is-on');
    button.addEventListener('click', () => {
      state.analyzeSection = name;
      renderAnalysis(report);
    });
    bar.append(button);
  }

  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  bar.append(spacer);

  for (const format of [
    { value: 'json', label: '导出 JSON' },
    { value: 'markdown', label: '导出 Markdown' },
    { value: 'text', label: '导出文本' },
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = format.label;
    button.addEventListener('click', () => exportAnalysis(format.value));
    bar.append(button);
  }
  return bar;
}

/** sectionBody 画当前子面板的内容。 */
function sectionBody(report) {
  const wrap = document.createElement('div');
  wrap.id = 'analyze-section';
  const name = state.analyzeSection;
  const meta = analyzeSections[name];

  const head = document.createElement('p');
  head.className = 'hint';
  head.textContent = meta ? meta.hint : '';
  wrap.append(head);

  if (loadedSections[name]) {
    wrap.append(renderAnalyzeSection(name, loadedSections[name]));
    return wrap;
  }
  wrap.append(note('正在载入…'));

  loadAnalyzeSection(name).then((items) => {
    loadedSections[name] = items;
    if (state.analyzeSection !== name) return;
    const target = document.getElementById('analyze-section');
    if (target) target.replaceChildren(head, renderAnalyzeSection(name, items));
  }).catch((error) => {
    const target = document.getElementById('analyze-section');
    if (target) target.replaceChildren(note(error.message));
  });
  return wrap;
}

/** loadAnalyzeSection 从 WASM 取一个章节。 */
async function loadAnalyzeSection(name) {
  const response = await call('analyzeSection', analyzeReportID, name);
  return response.items;
}

/** renderAnalyzeSection 按章节类型画内容。 */
function renderAnalyzeSection(name, items) {
  if (name === 'tree') return packageTree(items);
  if (name === 'pages') return pageTable(items);
  if (name === 'signatures') return signatureList(items);
  if (name === 'resources') return resourceTable(items);
  if (name === 'attachments') return attachmentList(items);
  if (name === 'annotations') return annotationList(items);
  return referenceTable(items);
}

/** exportAnalysis 导出分析报告。 */
async function exportAnalysis(format) {
  if (!analyzeReportID) {
    showNotice('请先运行一次分析。', true);
    return;
  }
  try {
    const result = await call('analyzeExport', analyzeReportID, format);
    downloadBlob(new Blob([result.data], { type: result.mime }), result.name);
  } catch (error) {
    showNotice(`导出失败：${error.message}`, true);
  }
}

// ——— 分析 Tab：各章节的渲染 ———

/**
 * packageTree 画包目录树。
 *
 * 目录默认只展开前两层：千页文档有两千多个节点，全部铺开既慢又没人看得完。
 * 展开状态按路径记在 state 里，重画分析概览后仍保持用户点开的样子。
 */
function packageTree(root) {
  const container = document.createElement('div');
  container.className = 'package-tree';
  if (!root) {
    container.append(note('本次分析未生成包目录树。'));
    return container;
  }
  const collapsed = state.treeCollapsed || (state.treeCollapsed = new Set());
  renderTreeNode(root, 0, container, collapsed);
  return container;
}

/** renderTreeNode 递归渲染一个树节点。 */
function renderTreeNode(node, depth, parent, collapsed) {
  const key = node.path || node.name;
  const children = node.children || [];
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = `${depth * 14}px`;

  if (children.length) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    const isCollapsed = collapsed.has(key);
    toggle.textContent = isCollapsed ? '▸' : '▾';
    toggle.setAttribute('aria-label', isCollapsed ? '展开' : '折叠');
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      if (isCollapsed) collapsed.delete(key); else collapsed.add(key);
      renderAnalysis(state.results.analyze);
    });
    row.append(toggle);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'tree-toggle';
    row.append(spacer);
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = node.kind === 'directory' ? '▤' : node.kind === 'xml' ? '⟨⟩' : '·';
  row.append(icon);

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = node.name || '/';
  name.title = node.path || '';
  row.append(name);

  if (node.duplicate) {
    const badge = document.createElement('span');
    badge.className = 'badge is-warn';
    badge.textContent = '重复条目';
    badge.title = '包内存在内容相同的同名条目';
    row.append(badge);
  }

  const size = document.createElement('span');
  size.className = 'tree-size';
  // 目录本身不占空间，显示子项数比显示 0 B 有信息量。
  size.textContent = node.kind === 'directory'
    ? `${children.length} 项`
    : formatBytes(node.size || 0);
  row.append(size);

  parent.append(row);
  if (collapsed.has(key)) return;
  for (const child of children) renderTreeNode(child, depth + 1, parent, collapsed);
}

/** pageTable 画页面统计表。 */
function pageTable(pages) {
  const table = simpleTable(
    ['页码', '文档', '图层', '宽×高 (mm)', '对象', '文字', '图片'],
    pages.map((page) => [
      String(page.page_number ?? ''),
      String(page.document_index ?? ''),
      String(page.layers ?? ''),
      page.size ? `${round(page.size.width)}×${round(page.size.height)}` : '—',
      String(page.objects ? page.objects.total : (page.page_objects ?? '')),
      String(page.text ? page.text.objects : ''),
      String(page.objects ? page.objects.image : ''),
    ]),
    pages.length ? '没有页面记录。' : null,
  );
  return table;
}

/** resourceTable 画资源表。 */
function resourceTable(resources) {
  const rows = (resources || []).map((item) => {
    const flags = [];
    if (!item.exists) flags.push('文件缺失');
    if (item.unused) flags.push('未被使用');
    if (item.embedded) flags.push('已内嵌');
    return [
      String(item.kind || ''),
      item.font_name || item.family_name || item.path || `#${item.id}`,
      String(item.declared ?? ''),
      String(item.used ?? ''),
      flags.join('、') || '—',
    ];
  });
  return simpleTable(
    ['类型', '名称', '引用次数', '使用页数', '标记'],
    rows,
    resources && resources.length ? '没有资源。' : null,
  );
}

/** attachmentList 画附件清单。 */
function attachmentList(attachments) {
  const rows = (attachments || []).map((item) => {
    const flags = [];
    if (!item.exists) flags.push('缺失');
    if (item.visible === false) flags.push('隐藏');
    return [
      item.name || item.id,
      item.format || '—',
      item.actual_size ? formatBytes(item.actual_size) : '—',
      item.usage || '—',
      flags.join('、') || '—',
    ];
  });
  return simpleTable(['名称', '格式', '实际大小', '用途', '标记'], rows,
    attachments && attachments.length ? '没有附件。' : null);
}

/** annotationList 画注解清单。 */
function annotationList(annotations) {
  const rows = (annotations || []).map((item) => [
    String(item.page_number ?? ''),
    item.type || '—',
    item.subtype || '—',
    item.creator || '—',
    item.remark || '—',
  ]);
  return simpleTable(['页码', '类型', '子类型', '创建者', '备注'], rows,
    annotations && annotations.length ? '没有注解。' : null);
}

/** referenceTable 画引用关系表。 */
function referenceTable(edges) {
  const rows = (edges || []).map((edge) => [
    edge.from || '—',
    edge.to || '—',
    edge.type || '—',
    edge.exists === false ? '目标不存在' : '正常',
  ]);
  return simpleTable(['来源', '目标', '类型', '状态'], rows,
    edges && edges.length ? '没有引用关系。' : null);
}

/**
 * signatureList 画签名与证书浏览器。
 *
 * 每个签名一张卡片，摘要、验签、信任三项判据分开列出而不是合成一个"有效"：
 * 档案场景要逐项留痕，而合成后看不出是哪一环出的问题。
 */
function signatureList(signatures) {
  const container = document.createElement('div');
  container.className = 'signature-list';
  if (!signatures || !signatures.length) {
    container.append(note('该文档没有签名。'));
    return container;
  }
  for (const signature of signatures) {
    container.append(signatureCard(signature));
  }
  return container;
}

/** signatureCard 画一个签名的卡片。 */
function signatureCard(signature) {
  const card = document.createElement('div');
  card.className = 'signature-card';

  const head = document.createElement('div');
  head.className = 'signature-head';
  const title = document.createElement('strong');
  title.textContent = signature.seal_name || signature.provider || signature.id;
  head.append(title);

  // 三项判据各自一个徽标。没执行过的显示"未校验"而不是"通过"——
  // 两者含义完全不同，混起来会给出虚假的安心。
  for (const [label, checked, valid, error] of [
    ['摘要', signature.digest_checked, signature.digest_valid, ''],
    ['验签', true, signature.verified, signature.verify_error || ''],
    ['信任', true, signature.trusted, ''],
  ]) {
    const badge = document.createElement('span');
    if (!checked) {
      badge.className = 'badge';
      badge.textContent = `${label}：未校验`;
    } else if (valid) {
      badge.className = 'badge is-ok';
      badge.textContent = `${label}：通过`;
    } else {
      badge.className = 'badge is-error';
      badge.textContent = `${label}：不通过`;
      if (error) badge.title = error;
    }
    head.append(badge);
  }
  card.append(head);

  const detail = document.createElement('div');
  detail.className = 'signature-detail';
  const parts = [];
  if (signature.company) parts.push(signature.company);
  if (signature.method) parts.push(`算法 ${signature.method}`);
  if (signature.date) parts.push(signature.date);
  if (Array.isArray(signature.pages) && signature.pages.length) {
    parts.push(`${signature.pages.length} 处签章`);
  }
  if (signature.stamp_count) parts.push(`${signature.stamp_count} 个印章文件`);
  detail.textContent = parts.join(' · ');
  card.append(detail);

  // 证书详情用 details 折叠：多数用户只看徽标，需要展开的是要核验的人。
  const details = document.createElement('details');
  details.className = 'signature-more';
  const summary = document.createElement('summary');
  summary.textContent = '证书详情';
  details.append(summary);
  details.append(signatureFields(signature));
  card.append(details);

  return card;
}

/** signatureFields 把签名记录里的其余字段列成键值表。 */
function signatureFields(signature) {
  const list = document.createElement('dl');
  list.className = 'kv';
  const rows = [
    ['签名 ID', signature.id],
    ['文档体', signature.document_index],
    ['提供者', signature.provider],
    ['公司', signature.company],
    ['算法', signature.method],
    ['时间', signature.date],
    ['印章算法', signature.seal_signature_algorithm],
    ['外层算法', signature.outer_signature_algorithm],
    ['摘要算法', signature.digest_method],
    ['验证时间', signature.verification_time],
    ['签章页码', Array.isArray(signature.pages) ? signature.pages.join('、') : ''],
  ];
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.className = 'mono';
    dd.textContent = String(value);
    list.append(dt, dd);
  }
  if (list.children.length === 0) list.append(note('没有更多字段。'));
  return list;
}

/** simpleTable 造一张简单表格。 */
function simpleTable(headers, rows, emptyText) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.className = 'report';

  const thead = document.createElement('thead');
  const head = document.createElement('tr');
  for (const label of headers) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  thead.append(head);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell === null || cell === undefined ? '—' : String(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);

  if (!rows.length) wrap.append(note(emptyText || '没有记录。'));
  return wrap;
}

/** round 保留一位小数，避免 210.00000000000003 这类浮点噪声进界面。 */
function round(value) {
  return Math.round(Number(value) * 10) / 10;
}

// ——— 校验 Tab ———

/** reportID 是当前报告的 WASM 侧 ID，导出时要用。 */
let reportID = 0;

/** renderToolBody 按当前 Tab 画内容。 */
/** OFD_ONLY_TABS 是必须有 OFD 文档句柄才能工作的工具页。 */
const OFD_ONLY_TABS = new Set(['validate', 'analyze', 'invoice', 'watermark', 'preserve']);

function renderToolBody() {
  const host = document.getElementById(state.tab);
  if (!host) return;

  // 这几个工具要在 OFD 文档上工作（页面、注解、资源、签名），非 OFD 输入
  // 没有文档句柄。说清楚，而不是把按钮禁用在那里让人猜为什么点不动。
  if (OFD_ONLY_TABS.has(state.tab) && !state.doc) {
    host.replaceChildren(note('该工具只支持 OFD 文件。请在左侧选择一个 OFD 文档。'));
    delete host.dataset.built;
    return;
  }
  if (state.tab === 'validate' || state.tab === 'analyze'
      || state.tab === 'invoice' || state.tab === 'watermark'
      || state.tab === 'merge' || state.tab === 'preserve') {
    const builders = {
      validate: buildValidatePanel,
      analyze: buildAnalyzePanel,
      invoice: buildInvoicePanel,
      watermark: buildWatermarkPanel,
      merge: buildMergePanel,
      preserve: buildPreservePanel,
    };
    if (!host.dataset.built) builders[state.tab](host);
    return;
  }
  if (state.results[state.tab]) return;
  host.replaceChildren();
  host.dataset.built = '1';

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const labels = {
    merge: '开始合并',
    preserve: '开始预检',
  };
  actions.append(actionButton(labels[state.tab], () => runTool(state.tab)));
  host.append(actions, note(toolHint(state.tab)));
}

/** toolHint 是各工具的一句话说明。 */
function toolHint(id) {
  if (id === 'watermark') return '可添加、替换或删除页面水印注解。';
  if (id === 'merge') return 'ZIP 级合并会重写包内路径，签名值可能失效。';
  if (id === 'preserve') return '先预检查看改动清单，确认后再执行。删除不可逆。';
  return '';
}

/** buildValidatePanel 搭出校验面板的骨架：参数区 + 报告区。 */
function buildValidatePanel(host) {
  host.replaceChildren();
  host.dataset.built = '1';

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const start = actionButton('开始校验', runValidation);
  start.id = 'validate-start';
  start.disabled = !state.doc;
  actions.append(start);

  const details = document.createElement('details');
  details.className = 'validate-options';
  const summary = document.createElement('summary');
  summary.textContent = '校验选项';
  const body = document.createElement('div');
  body.className = 'option-body';
  for (const field of validateSchema) {
    body.append(validateField(field));
  }
  details.append(summary, body);

  const report = document.createElement('div');
  report.id = 'validate-report';
  report.className = 'report-host';

  host.append(actions, details, report, disclaimerNote());
}

/** validateField 画一个校验参数字段。 */
function validateField(field) {
  const wrap = document.createElement('div');
  wrap.className = 'option';

  if (field.type === 'check') {
    const label = document.createElement('label');
    label.className = 'option-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(validateOptions[field.key]);
    input.addEventListener('change', () => {
      validateOptions[field.key] = input.checked;
    });
    const text = document.createElement('span');
    text.textContent = field.label;
    label.append(input, text);
    wrap.append(label);
    if (field.hint) wrap.append(hintNode(field.hint));
    return wrap;
  }

  const label = document.createElement('label');
  label.htmlFor = `validate-${field.key}`;
  label.textContent = field.label;

  let input;
  if (field.type === 'select') {
    input = document.createElement('select');
    for (const item of field.options) {
      const option = document.createElement('option');
      option.value = String(item.value);
      option.textContent = item.label;
      if (validateOptions[field.key] === item.value) option.selected = true;
      input.append(option);
    }
    input.addEventListener('change', () => {
      validateOptions[field.key] = input.value;
    });
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = field.placeholder || '';
    input.value = validateOptions[field.key] || '';
    input.addEventListener('input', () => {
      validateOptions[field.key] = input.value.trim();
    });
  }
  input.id = `validate-${field.key}`;
  wrap.append(label, input);
  if (field.hint) wrap.append(hintNode(field.hint));
  return wrap;
}

/** disclaimerNote 是所有工具共用的免责说明。 */
function disclaimerNote() {
  const node = document.createElement('p');
  node.className = 'hint';
  node.textContent = '本工具不保证校验结果适用于特定业务、法律或合规场景。'
    + '电子签名的有效性需要用 OFD 阅读器另行核验。';
  return node;
}

/**
 * 取校验报告的宿主元素，必要时先建出面板。
 *
 * 「开始校验」按钮只在面板里，而用户也可能从别处触发校验；宿主缺失时
 * 直接建一个，而不是让 getElementById 返回 null 后在 replaceChildren 上崩。
 */
function validateReportHost() {
  let host = document.getElementById('validate-report');
  if (host) return host;
  const panel = document.getElementById('validate');
  if (!panel) return null;
  buildValidatePanel(panel);
  host = document.getElementById('validate-report');
  if (host) return host;
  // 面板结构被改动导致宿主仍不存在时，兜一个容器进去，
  // 至少让报告能显示出来而不是整块面板空着。
  host = document.createElement('div');
  host.id = 'validate-report';
  host.className = 'report-host';
  panel.append(host);
  return host;
}

/** resetValidatePanel 重置校验面板，让它回到"未校验"状态。 */
function resetValidatePanel() {
  const host = document.getElementById('validate');
  if (!host) return;
  delete host.dataset.built;
  reportID = 0;
  if (state.tab === 'validate') {
    buildValidatePanel(host);
  } else {
    host.replaceChildren(note('载入 OFD 后点击「开始校验」。'));
  }
}

/** runValidation 执行校验并画报告。 */
async function runValidation() {
  if (!state.doc || state.busy) return;
  state.busy = true;
  const host = validateReportHost();
  host.replaceChildren(note('正在校验…'));
  setTask('校验中', 0, true);

  const started = performance.now();
  try {
    const response = await call('validateDocument', state.doc.id, { ...validateOptions });
    reportID = response.reportId;
    state.results.validate = response.report;
    renderValidation(response.report);
    const elapsed = (performance.now() - started) / 1000;
    finishTask('校验完成', `${elapsed.toFixed(1)} 秒`);
  } catch (error) {
    host.replaceChildren(note(error.message));
    finishTask('校验失败', error.message);
  } finally {
    state.busy = false;
  }
}

/** renderValidation 画一份校验报告。 */
function renderValidation(report) {
  const host = validateReportHost();
  if (!host) return null;
  host.replaceChildren();

  host.append(statusBar(report));
  host.append(checkRow(report));
  host.append(issueFilterBar(report));
  host.append(issueTable(report));
  host.append(exportRow(report));
  return host;
}

// severityOrder 决定问题排序：先错误、再警告、最后提示。
const severityOrder = { error: 0, warning: 1, info: 2 };

/** statusBar 画结论条。 */
function statusBar(report) {
  const bar = document.createElement('div');
  bar.className = `notice is-${statusTone(report.status)}`;
  const title = document.createElement('strong');
  title.textContent = `校验结论：${report.statusLabel}`;
  bar.append(title);
  const detail = document.createElement('div');
  const parts = [`${report.input.name} · ${formatBytes(report.input.size)}`];
  if (report.profile) parts.push(`按 ${report.profile} 规则校验`);
  parts.push(`耗时 ${(report.durationMS / 1000).toFixed(1)} 秒`);
  detail.textContent = parts.join(' · ');
  bar.append(detail);
  return bar;
}

/** statusTone 把结论映射成配色。 */
function statusTone(status) {
  if (status === 'valid') return 'ok';
  if (status === 'invalid') return 'error';
  if (status === 'error') return 'error';
  return 'warn';
}

/** checkRow 画阶段结果。 */
function checkRow(report) {
  const row = document.createElement('div');
  row.className = 'report-summary';
  for (const check of report.checks) {
    const badge = document.createElement('span');
    badge.className = `badge is-${checkTone(check.status)}`;
    badge.textContent = `${check.nameLabel}：${check.statusLabel}`;
    badge.title = check.name;
    row.append(badge);
  }
  return row;
}

/** checkTone 把阶段状态映射成配色。 */
function checkTone(status) {
  if (status === 'pass' || status === 'ok') return 'ok';
  if (status === 'fail' || status === 'error') return 'error';
  return 'info';
}

/** issueFilterBar 画筛选控件。 */
function issueFilterBar(report) {
  const bar = document.createElement('div');
  bar.className = 'filter-bar';

  const counts = countBySeverity(report.issues);
  bar.append(countBadge(`错误 ${counts.error}`, 'error'));
  bar.append(countBadge(`警告 ${counts.warning}`, 'warn'));
  bar.append(countBadge(`提示 ${counts.info}`, 'info'));

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '搜索消息、条款或包内路径';
  search.className = 'filter-search';
  search.addEventListener('input', () => {
    state.issueFilter.text = search.value.trim();
    refreshIssueTable(report);
  });
  bar.append(search);

  if (report.clauses && report.clauses.length) {
    const select = document.createElement('select');
    select.className = 'filter-select';
    select.append(optionNode('', `全部条款（${report.clauses.length}）`));
    for (const clause of report.clauses) select.append(optionNode(clause, clause));
    select.value = state.issueFilter.clause;
    select.addEventListener('change', () => {
      state.issueFilter.clause = select.value;
      refreshIssueTable(report);
    });
    bar.append(select);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'ghost';
  clear.textContent = '清除筛选';
  clear.addEventListener('click', () => {
    state.issueFilter = { severity: '', clause: '', text: '' };
    renderValidation(report);
  });
  bar.append(clear);
  return bar;
}

function countBadge(text, tone) {
  const badge = document.createElement('span');
  badge.className = `badge is-${tone}`;
  badge.textContent = text;
  return badge;
}

function optionNode(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

/** countBySeverity 统计各严重程度的问题数。 */
function countBySeverity(issues) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) {
    if (counts[issue.severity] !== undefined) counts[issue.severity]++;
  }
  return counts;
}

/** filterIssues 按当前筛选条件过滤并排序。 */
function filterIssues(issues, filter) {
  const text = filter.text.toLowerCase();
  const matched = issues.filter((issue) => {
    if (filter.severity && issue.severity !== filter.severity) return false;
    if (filter.clause && !(issue.clause || []).includes(filter.clause)) return false;
    if (!text) return true;
    const haystack = [
      issue.message, issue.hint || '', issue.file || '',
      issue.xpath || '', issue.code, ...(issue.clause || []),
    ].join(' ').toLowerCase();
    return haystack.includes(text);
  });
  // 排序而非改变原数组：报告在内存里还要用于导出，不能被界面上的
  // 筛选顺序改掉。
  return matched.slice().sort((a, b) => {
    const bySeverity = (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9);
    if (bySeverity !== 0) return bySeverity;
    const byFile = (a.file || '').localeCompare(b.file || '');
    if (byFile !== 0) return byFile;
    return (a.line || 0) - (b.line || 0);
  });
}

/** issueTable 画问题表格。 */
function issueTable(report) {
  const container = document.createElement('div');

  const table = document.createElement('table');
  table.className = 'report';
  table.id = 'issue-table';

  const head = document.createElement('tr');
  for (const label of ['严重程度', '阶段', '条款', '说明', '位置']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);

  // thead 与 tbody 都要挂在 table 上：挂到外层容器里的话，浏览器会把它们
  // 当普通子元素渲染，表格结构就散了。
  table.append(thead, document.createElement('tbody'));

  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.append(table);

  const summary = document.createElement('p');
  summary.className = 'hint';
  summary.id = 'issue-summary';

  container.append(wrap, summary);
  // 直接把元素传进去，不靠 getElementById 反查：此时 container 还没挂上
  // 文档树，getElementById 找不到未插入的节点。Node 侧的 DOM 桩用注册表
  // 做 id 索引，反查照样能命中，于是这个 bug 在桩测试里是绿的，
  // 到浏览器里表格却是空的。
  fillIssueTable(table, summary, report);
  return container;
}

/**
 * fillIssueTable 把筛选后的问题写进表格。
 *
 * 元素由调用方传入：初次渲染时表格还没插入文档树，靠 id 反查会落空。
 */
function fillIssueTable(table, summary, report) {
  const body = table.querySelector('tbody');
  body.replaceChildren();
  const rows = filterIssues(report.issues, state.issueFilter);

  for (const issue of rows) {
    body.append(issueRow(issue));
  }
  summary.textContent = report.truncated
    ? `显示 ${rows.length} 条（共 ${report.issues.length + report.truncated} 条，`
      + `界面最多显示 ${report.issues.length} 条；导出文件含全部问题）`
    : `显示 ${rows.length} 条，共 ${report.issues.length} 条`;

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'hint';
    td.textContent = report.issues.length ? '没有符合筛选条件的问题。' : '没有发现问题。';
    tr.append(td);
    body.append(tr);
  }
}

/** refreshIssueTable 按当前筛选重画表格内容。用于筛选变化后的就地刷新。 */
function refreshIssueTable(report) {
  const table = document.getElementById('issue-table');
  const summary = document.getElementById('issue-summary');
  if (!table || !summary) return;
  fillIssueTable(table, summary, report);
}

/** issueRow 画一行问题。 */
function issueRow(issue) {
  const tr = document.createElement('tr');

  const severity = document.createElement('td');
  severity.className = `sev-${issue.severity}`;
  severity.textContent = issue.severityLabel;
  tr.append(severity);

  const stage = document.createElement('td');
  stage.textContent = issue.stageLabel;
  stage.title = issue.stage;
  tr.append(stage);

  const clause = document.createElement('td');
  clause.className = 'mono';
  if (issue.clause && issue.clause.length) {
    for (const [index, item] of issue.clause.entries()) {
      if (index) clause.append(document.createTextNode(' '));
      clause.append(document.createTextNode(item));
    }
  } else {
    clause.textContent = '—';
  }
  tr.append(clause);

  const message = document.createElement('td');
  const text = document.createElement('div');
  text.textContent = issue.message;
  message.append(text);
  if (issue.hint) {
    const hint = document.createElement('div');
    hint.className = 'issue-hint';
    hint.textContent = `建议：${issue.hint}`;
    message.append(hint);
  }
  if (!issue.clause && issue.code) {
    const code = document.createElement('div');
    code.className = 'mono issue-code';
    code.textContent = issue.code;
    message.append(code);
  }
  tr.append(message);

  const location = document.createElement('td');
  location.className = 'mono truncate';
  if (issue.file) {
    location.textContent = issue.line
      ? `${issue.file}:${issue.line}`
      : issue.file;
    location.title = issue.xpath ? `${issue.file} · ${issue.xpath}` : issue.file;
  } else {
    location.textContent = '—';
  }
  tr.append(location);
  return tr;
}

/** exportRow 画导出按钮。 */
function exportRow(report) {
  const row = document.createElement('div');
  row.className = 'tool-actions';
  // 不含 XLSX：它要拖 excelize 进 wasm，实测 51.3MB → 61.4MB、gzip 多 2MB。
  // 对着一张已经在页面上的表格不值这个体积。
  const formats = [
    { value: 'json', label: '导出 JSON' },
    { value: 'markdown', label: '导出 Markdown' },
    { value: 'text', label: '导出文本' },
  ];
  for (const format of formats) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = format.label;
    button.addEventListener('click', () => exportReport(format.value));
    row.append(button);
  }
  return row;
}

/** exportReport 导出报告文件。 */
async function exportReport(format) {
  if (!reportID) return;
  try {
    const result = await call('validateExport', reportID, format);
    downloadBlob(new Blob([result.data], { type: result.mime }), result.name);

  } catch (error) {
    showNotice(`导出失败：${error.message}`, true);
  }
}

/** downloadBlob 下载一个 Blob。 */
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ——— 内存面板 ———

/** refreshMemory 刷新内存占用。 */
async function refreshMemory() {
  const stats = await call('memoryStats');
  const body = document.getElementById('memory-body');
  body.replaceChildren();
  const rows = [
    ['WASM 线性内存', formatBytes(stats.linear)],
    ['Go 存活堆', formatBytes(stats.heapAlloc)],
    ['已用堆', formatBytes(stats.heapInuse)],
    ['已归还系统', formatBytes(stats.heapReleased)],
    ['GC 次数', String(stats.numGC)],
    ['打开的文档', String(stats.openDocuments)],
    ['文档字节', formatBytes(stats.documentBytes)],
    ['回退字体', formatBytes(stats.fallbackFontBytes)],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    body.append(dt, dd);
  }
}

// ——— 事件绑定 ———

/** bindEvents 绑定全部交互。 */
function bindEvents() {
  const dropzone = document.getElementById('dropzone');
  const input = document.getElementById('file-input');

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    addFiles([...input.files]);
    input.value = '';
  });

  // 整页作为投放区：用户从文件管理器拖到页面任何位置都应该被接住。
  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    document.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === 'drop' || event.target === document.documentElement) {
        dropzone.classList.remove('is-over');
      }
    });
  }
  document.addEventListener('drop', (event) => {
    if (event.dataTransfer && event.dataTransfer.files.length) {
      addFiles([...event.dataTransfer.files]);
    }
  });
  // 粘贴文件：从截图工具或聊天窗口复制过来的 OFD。
  document.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData ? event.clipboardData.files : [])];
    if (files.length) addFiles(files);
  });

  document.getElementById('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    selectTab(tab.dataset.tab);
  });

  document.getElementById('task-cancel').addEventListener('click', async () => {
    if (!state.activeJobID) return;
    try {
      await call('cancel', state.activeJobID);
    } catch (error) {
      showNotice(`取消失败：${error.message}`, true);
    }
  });
  document.getElementById('task-download').addEventListener('click', downloadResult);

  document.getElementById('font-button').addEventListener('click', toggleFontPanel);
  document.getElementById('font-close').addEventListener('click', () => {
    document.getElementById('font-panel').hidden = true;
  });
  document.getElementById('font-local').addEventListener('click', addLocalFonts);
  document.getElementById('font-upload').addEventListener('click', () => {
    document.getElementById('font-input').click();
  });
  document.getElementById('font-input').addEventListener('change', (event) => {
    uploadFallbackFonts([...event.target.files]);
    event.target.value = '';
  });

  document.getElementById('memory-button').addEventListener('click', async () => {
    const panel = document.getElementById('memory-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) refreshMemory();
  });
  document.getElementById('memory-close').addEventListener('click', () => {
    document.getElementById('memory-panel').hidden = true;
  });
  document.getElementById('memory-refresh').addEventListener('click', refreshMemory);
  document.getElementById('memory-gc').addEventListener('click', async () => {
    await call('gc');
    refreshMemory();
  });

  document.getElementById('about-button').addEventListener('click', () => {
    document.getElementById('about-dialog').showModal();
  });

  const viewer = document.getElementById('image-viewer');
  document.getElementById('image-viewer-close').addEventListener('click', () => {
    if (typeof viewer.close === 'function') viewer.close();
    else viewer.removeAttribute('open');
  });
  // 点空白处关闭：点击目标是 dialog 自身时说明点在了遮罩上（内容在子节点里）。
  viewer.addEventListener('click', (event) => {
    if (event.target === viewer && typeof viewer.close === 'function') viewer.close();
  });

  window.addEventListener('beforeunload', releaseObjectURLs);
}

/** selectTab 切换工具页。 */
function selectTab(name) {
  state.tab = name;
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  }
  renderToolBody();
}

/**
 * addFiles 把新文件加入队列，并选中最后拖进来的那个。
 *
 * 选中"最后拖入的"而不是"队列里第一个"：拖第二个文件时用户的注意力已经
 * 转到它身上了，不切过去就得再点一次卡片才知道当前在处理哪个。
 * 队列里已解析的文件不受影响——切回去时会重新打开，见 selectFile。
 */
function addFiles(files) {
  const added = [];
  for (const file of files) {
    const item = {
      id: state.nextFileID++,
      file,
      name: file.name,
      size: file.size,
      state: 'pending',
      doc: null,
      error: '',
    };
    state.files.push(item);
    added.push(item);
  }
  renderFiles();
  if (added.length) selectFile(added[added.length - 1].id);
}

// ——— 启动 ———

/** 更新启动进度。 */
function bootProgress(loaded, total) {
  const fill = document.getElementById('boot-fill');
  const status = document.getElementById('boot-status');
  if (total > 0) {
    fill.classList.remove('is-indeterminate');
    fill.style.width = `${Math.round((loaded / total) * 100)}%`;
    status.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
  } else {
    fill.classList.add('is-indeterminate');
    status.textContent = `已下载 ${formatBytes(loaded)}`;
  }
}

/**
 * 注册 Service Worker。
 *
 * 不 await：注册与激活不该挡在引擎启动前面，用户看到启动遮罩就意味着
 * 马上能用，而不是还要再等一次网络往返。装好后由 activate 事件接管。
 *
 * 失败只记日志不提示：SW 是加速手段，没有它页面照样能用，
 * 为此弹一条错误只会让人以为工具坏了。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js', {
      // 绕过 HTTP 缓存检查版本，发布后第一次导航就能发现新版本。
      // 不加的话浏览器会拿 HTTP 缓存里的旧脚本比对，白等一轮。
      updateViaCache: 'none',
    }).catch((error) => {
      console.warn('Service Worker 注册失败：', error);
    });
  });
}

async function main() {
  const boot = document.getElementById('boot');
  const error = document.getElementById('boot-error');

  registerServiceWorker();

  worker.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type === 'boot') bootProgress(message.loaded, message.total);
    else if (message.type === 'bootError') {
      boot.querySelector('.boot-note').textContent = '引擎载入失败';
      error.hidden = false;
      error.textContent = message.error;
      document.getElementById('boot-status').textContent = '';
    }
  });

  bindEvents();

  try {
    await ready;
    boot.hidden = true;
    state.capabilities = await call('capabilities');
    state.options = {};
    renderFiles();
    renderFormatGrid();
    renderOptions();
  } catch (cause) {
    boot.querySelector('.boot-note').textContent = '引擎载入失败';
    error.hidden = false;
    error.textContent = cause.message;
    document.getElementById('boot-status').textContent = '';
  }
}

main();

// ——— 水印 ———

/**
 * 水印默认值。
 *
 * 参数取的是"直接能用"的组合而不是库的默认值：库默认字号 9、颜色无、
 * 布局单条放在左上，而"机密"这类水印的实际用法是平铺 + 倾斜。
 */
const watermarkDefaults = {
  action: 'add',
  kind: 'text',
  text: '机密 内部使用',
  size: 14,
  color: '#c00000',
  opacity: 60,
  layout: 'tile',
  rotation: 30,
  font: '',
  signatures: 'preserve',
  skipReadOnly: false,
  skipPermissions: false,
};

/** buildWatermarkPanel 搭出水印面板骨架。 */
function buildWatermarkPanel(host) {
  host.replaceChildren();
  host.dataset.built = '1';

  const body = document.createElement('div');
  body.className = 'wm-body';

  body.append(watermarkForm(), watermarkActionRow(), watermarkPagePicker());

  const notices = document.createElement('div');
  notices.id = 'watermark-notices';

  const result = document.createElement('div');
  result.id = 'watermark-result';
  result.className = 'report-host';

  // 预览区放在水印面板内部：v1 写的是转换面板的 #preview-strip，
  // 而那个节点在另一个 panel 里，用户在水印 Tab 上根本看不见，
  // 只看到"预览已生成"却找不到图。
  const preview = document.createElement('div');
  preview.id = 'watermark-preview-strip';
  preview.className = 'preview-strip';
  preview.setAttribute('aria-label', '水印预览');

  host.append(body, notices, result, preview, watermarkNote());

  // 必须先插入 DOM 再渲染子部件：renderWatermarkPages 与 syncWatermarkFields
  // 都按 id / 选择器回查节点，节点还挂在局部变量上时回查拿到的是 null，
  // 于是页码网格空着、操作标记也没设上——而这些函数本身不报错。
  renderWatermarkPages();
  syncWatermarkFields();
  renderWatermarkInventory();
}

/** watermarkForm 画参数表单。 */
function watermarkForm() {
  const form = document.createElement('div');
  form.className = 'wm-form';
  form.addEventListener('change', syncWatermarkFields);

  form.append(watermarkActionPicker());

  const kind = document.createElement('div');
  kind.className = 'wm-kind';
  kind.append(
    radioGroup('kind', [
      { value: 'text', label: '文字' },
      { value: 'image', label: '图片' },
    ], watermarkDefaults.kind, '水印类型'),
  );
  form.append(kind);

  const textBox = document.createElement('div');
  textBox.className = 'wm-fields';
  textBox.id = 'wm-text-fields';
  textBox.append(
    textField('text', '水印文字', watermarkDefaults.text),
    numberField('size', '字号 (mm)', watermarkDefaults.size, 1, 200, 1),
    colorField('color', '颜色', watermarkDefaults.color),
    rangeField('opacity', '不透明度', watermarkDefaults.opacity,
      '0 完全透明', '255 完全不透明'),
  );
  form.append(textBox);

  const imageBox = document.createElement('div');
  imageBox.className = 'wm-fields';
  imageBox.id = 'wm-image-fields';
  imageBox.hidden = true;
  imageBox.append(
    fileField('image', '图片文件（PNG / JPEG）'),
    numberField('imageWidth', '宽度 (mm)', 40, 1, 2000, 1),
    numberField('imageHeight', '高度 (mm，0 表示按比例)', 0, 0, 2000, 1),
    numberField('imageOpacity', '不透明度（仅 PNG）', 255, 0, 255, 1),
  );
  form.append(imageBox);

  const layoutBox = document.createElement('div');
  layoutBox.className = 'wm-fields';
  layoutBox.append(
    layoutPicker(),
    numberField('rotation', '旋转角度 (°)', watermarkDefaults.rotation, -360, 360, 1),
    numberField('x', '水平偏移 (mm)', 0, -2000, 2000, 1),
    numberField('y', '垂直偏移 (mm)', 0, -2000, 2000, 1),
    fontPicker(),
  );
  form.append(layoutBox);
  return form;
}

/** watermarkActionPicker 画操作选择。 */
function watermarkActionPicker() {
  const box = document.createElement('div');
  box.className = 'wm-actions';
  box.append(radioGroup('action', [
    { value: 'add', label: '添加', hint: '在所选页各加一条' },
    { value: 'replace', label: '替换', hint: '改掉内容，保留注解 ID' },
    { value: 'remove', label: '删除', hint: '清掉匹配的水印注解' },
  ], watermarkDefaults.action, '操作'));
  return box;
}

/** layoutPicker 画布局方式。 */
function layoutPicker() {
  const select = selectField('layout', '布局方式', [
    { value: 'tile', label: '平铺' },
    { value: 'center', label: '居中' },
    { value: 'manual', label: '手动位置' },
  ], watermarkDefaults.layout);
  select.classList.add('wm-layout');
  return select;
}

/** fontPicker 画字体选择。 */
function fontPicker() {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const name = document.createElement('span');
  name.className = 'field-label';
  name.textContent = '字体';
  const select = document.createElement('select');
  select.id = 'wm-font';
  select.append(optionNode('', '自动（取文档字体）'));
  for (const font of (state.doc && state.doc.fonts) || []) {
    select.append(optionNode(String(font.id),
      `${font.name}（ID ${font.id}${font.embedded ? '，已内嵌' : '，未内嵌'}）`));
  }
  select.addEventListener('change', readWatermarkOptions);
  wrap.append(name, select);
  return wrap;
}

/** watermarkPagePicker 画页码选择。 */
function watermarkPagePicker() {
  const box = document.createElement('div');
  box.className = 'wm-pages';
  const title = document.createElement('div');
  title.className = 'group-title';
  title.id = 'wm-pages-title';
  box.append(title);

  const grid = document.createElement('div');
  grid.className = 'wm-page-grid';
  grid.id = 'wm-page-grid';
  box.append(grid);

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const all = actionButton('全部页面', () => {
    state.watermarkPages = null;
    renderWatermarkPages();
  });
  const clear = actionButton('清空选择', () => {
    state.watermarkPages = new Set();
    renderWatermarkPages();
  });
  all.className = 'ghost';
  clear.className = 'ghost';
  actions.append(all, clear);
  box.append(actions);
  return box;
}

/** renderWatermarkPages 重画页码网格。 */
function renderWatermarkPages() {
  const grid = document.getElementById('wm-page-grid');
  const title = document.getElementById('wm-pages-title');
  // 回查不到就是还没插入 DOM，静默返回即可——不能在这里 throw，
  // 否则 buildWatermarkPanel 的后续步骤全都不会执行。
  if (!grid || !title) return;
  grid.replaceChildren();
  const total = (state.doc && state.doc.pageCount) || 0;
  if (!total) {
    title.textContent = '页面选择';
    grid.append(note('未载入文档。'));
    return;
  }
  const all = state.watermarkPages === null;
  const selected = state.watermarkPages || new Set();
  title.textContent = all
    ? `页面选择（全部 ${total} 页）`
    : `页面选择（已选 ${selected.size} / ${total} 页）`;

  // 页数多时不一次画完：上千个按钮会把面板撑到无法操作。
  const limit = 200;
  const shown = Math.min(total, limit);
  for (let index = 0; index < shown; index++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wm-page';
    button.textContent = String(index + 1);
    const on = all || selected.has(index);
    button.classList.toggle('is-on', on);
    button.addEventListener('click', () => toggleWatermarkPage(index));
    grid.append(button);
  }
  if (total > shown) {
    grid.append(note(`另有 ${total - shown} 页未显示，可在「范围」里直接填页码。`));
  }
}

/**
 * toggleWatermarkPage 切换单页选中状态。
 *
 * 从"全部"状态下第一次点击，落点是**只选这一页**，不是"从全部里去掉这一页"。
 * 后者符合字面语义但完全不符合意图：用户点某一页通常就是想"只处理这一页"，
 * 而"全部减去这一页"反而制造了一个从没想过的选择。
 * 之后再点同一页才是普通的开关行为。
 */
function toggleWatermarkPage(index) {
  if (state.watermarkPages === null) {
    state.watermarkPages = new Set([index]);
    renderWatermarkPages();
    return;
  }
  const current = new Set(state.watermarkPages);
  if (current.has(index)) current.delete(index);
  else current.add(index);
  state.watermarkPages = current;
  renderWatermarkPages();
}

/** watermarkActionRow 画执行按钮行。 */
function watermarkActionRow() {
  const row = document.createElement('div');
  row.className = 'tool-actions';
  const apply = actionButton('应用', runWatermark);
  apply.id = 'watermark-start';
  apply.disabled = !state.doc;
  const preview = actionButton('预览效果', previewWatermark);
  preview.id = 'watermark-preview';
  preview.disabled = !state.doc;
  preview.className = 'ghost';
  row.append(apply, preview);
  return row;
}

/**
 * 按当前类型与操作切换显隐。
 *
 * replace 与 add 的外观参数完全一致，remove 则一个都不需要显示——
 * 让用户去填一堆不会被读取的字段只会误导。
 */
function syncWatermarkFields() {
  const form = document.querySelector('.wm-form');
  if (!form) return;
  // 在表单子树里找而不是 document 全局找：面板可能被重建，
  // 而全局 querySelector 会拿到上一个文档里已脱离树的节点。
  // querySelectorAll 返回的是 NodeList，没有 find；必须先展开成数组。
  const checked = (name) => form.querySelector(`input[name="${name}"]:checked`)
    || [...form.querySelectorAll(`input[name="${name}"]`)]
      .find((node) => node.checked);
  const kind = checked('wm-kind');
  const action = checked('wm-action');
  const text = document.getElementById('wm-text-fields');
  const image = document.getElementById('wm-image-fields');
  if (text && image) {
    const isImage = Boolean(kind && kind.value === 'image');
    image.hidden = !isImage;
    text.hidden = isImage;
  }
  if (form && action) {
    form.dataset.action = action.value;
    for (const node of form.querySelectorAll('.wm-fields')) {
      // 布局与字体对图片水印仍然有意义（图片也支持平铺），因此只收起文本专属项。
      const textOnly = node.id === 'wm-text-fields';
      node.dataset.stale = textOnly && action.value === 'remove' ? '1' : '';
      node.style.opacity = node.dataset.stale ? '0.45' : '';
    }
  }
}

/** readWatermarkOptions 汇总当前参数。 */
function readWatermarkOptions() {
  const value = (id, fallback) => {
    const node = document.getElementById(id);
    return node ? node.value : fallback;
  };
  // 单选组是一组同名 radio，没有 id——按 id 取会永远落回默认值，
  // 于是"用户选了删除，参数里还是 add"这种不一致会一路带到 WASM。
  const choice = (name, fallback) => {
    const group = [...document.querySelectorAll(`input[name="${name}"]`)];
    const picked = group.find((node) => node.checked);
    return picked ? picked.value : fallback;
  };
  const kind = choice('wm-kind', watermarkDefaults.kind);
  const options = {
    action: choice('wm-action', watermarkDefaults.action),
    kind,
    text: value('wm-text', watermarkDefaults.text),
    size: Number(value('wm-size', watermarkDefaults.size)),
    color: value('wm-color', watermarkDefaults.color),
    opacity: Number(value('wm-opacity', watermarkDefaults.opacity)),
    layout: value('wm-layout', watermarkDefaults.layout),
    rotation: Number(value('wm-rotation', watermarkDefaults.rotation)),
    x: Number(value('wm-x', 0)),
    y: Number(value('wm-y', 0)),
    font: value('wm-font', ''),
    signatures: value('wm-signatures', watermarkDefaults.signatures),
    skipReadOnly: Boolean(document.getElementById('wm-skip-readonly')?.checked),
    skipPermissions: Boolean(document.getElementById('wm-skip-permissions')?.checked),
  };
  if (kind === 'image') {
    options.imageWidth = Number(value('wm-imageWidth', 40));
    options.imageHeight = Number(value('wm-imageHeight', 0));
    const opacity = Number(value('wm-imageOpacity', 255));
    // 255 就是"完全不透明"，与不设等价，不必传。
    if (opacity < 255) options.imageOpacity = opacity;
    // File 只在这里留引用，真正读成字节发生在 assembleImageWatermark：
    // 用户可能只调文字水印，或者中途换文件，没必要为一次没用的选择
    // 付出几十 MB 的读取。
    const picker = document.getElementById('wm-image');
    options.imageFile = picker && picker.files && picker.files[0]
      ? picker.files[0] : null;
    options.imageFormat = options.imageFile
      ? (/\.jpe?g$/i.test(options.imageFile.name) ? 'JPEG' : 'PNG')
      : 'PNG';
  }
  return options;
}

/**
 * 把图片水印的 File 读成字节，塞进请求。
 *
 * 不透明度只能烘焙进 PNG 的 alpha 通道，其它格式在这里就拦住，
 * 免得用户等到产物出来才发现没生效。
 */
async function assembleImageWatermark(payload, options) {
  if (options.kind !== 'image') return payload;
  if (!options.imageFile) {
    throw new Error('请先选择水印图片文件');
  }
  if (options.imageOpacity !== undefined && options.imageFormat !== 'PNG') {
    throw new Error('设置不透明度时图片水印只支持 PNG，请换成 PNG 文件');
  }
  const buffer = await options.imageFile.arrayBuffer();
  payload.image = new Uint8Array(buffer);
  payload.imageFormat = options.imageFormat;
  if (options.imageOpacity !== undefined) {
    payload.imageOpacity = options.imageOpacity;
  }
  return payload;
}

/** watermarkPayload 组装给 WASM 的请求。 */
function watermarkPayload(options) {
  const payload = { documentId: state.doc.id, action: options.action };
  // remove 只需要匹配条件，外观参数一律不发过去。
  if (options.action !== 'remove') {
    Object.assign(payload, {
      kind: options.kind,
      text: options.text,
      size: options.size,
      color: options.color,
      opacity: options.opacity,
      layout: options.layout,
      rotation: options.rotation,
      x: options.x,
      y: options.y,
    });
    if (options.font) payload.font = options.font;
    if (options.kind === 'image') {
      payload.imageWidth = options.imageWidth;
      payload.imageHeight = options.imageHeight;
    }
  }
  payload.signatures = options.signatures;
  payload.skipReadOnly = options.skipReadOnly;
  payload.skipPermissions = options.skipPermissions;
  if (state.watermarkPages !== null && state.watermarkPages.size) {
    payload.pages = [...state.watermarkPages];
  }
  return payload;
}

/** runWatermark 执行一次水印操作。 */
async function runWatermark() {
  if (!state.doc || state.busy) return;
  const options = readWatermarkOptions();
  const payload = watermarkPayload(options);

  state.busy = true;
  setTask('处理中', 0, true);
  const notices = document.getElementById('watermark-notices');
  if (notices) notices.replaceChildren();

  try {
    await assembleImageWatermark(payload, options);
    const result = await convert({ ...payload, command: 'watermark' }, null);
    state.watermarkResult = result;
    renderWatermarkResult(result, options);
    finishTask('完成');
  } catch (error) {
    renderWatermarkError(error.message);
    finishTask('处理失败', error.message);
  } finally {
    state.busy = false;
  }
}

/** previewWatermark 在预览区渲染加水印后的第一页。 */
async function previewWatermark() {
  if (!state.doc || state.busy) return;
  const options = readWatermarkOptions();
  if (options.action === 'remove') {
    showNotice('删除操作没有外观可预览，请直接应用。');
    return;
  }
  state.busy = true;
  setTask('生成预览', 0, true);
  try {
    const payload = watermarkPayload({ ...options, action: 'add' });
    await assembleImageWatermark(payload, options);
    // command 必须显式给：convert 默认走 'convert' 命令，漏了这一步会拿
    // 水印的参数去跑转换，报出的错和真正的原因（没指定目标格式）对不上。
    const result = await convert({ ...payload, command: 'watermark' }, null);
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const doc = await call('openDocument', bytes, 'preview.ofd');
    try {
      // 预览用的临时文档在 finally 里就关掉了，没法事后再按需重渲染，
      // 所以这里直接按较高 DPI 渲染一次，缩略图与大图共用同一张。
      const page = await call('renderPage', doc.id, 0, { dpi: 150, background: 'white' });
      const strip = document.getElementById('watermark-preview-strip');
      if (!strip) return;
      const src = blobURL(new Blob([page.data], { type: 'image/png' }));
      strip.replaceChildren();
      strip.append(
        previewThumb(src, '水印预览', '预览', () => openImageViewer(src, '水印预览')),
        note('预览只渲染第 1 页；点缩略图可看大图，应用后能在结果里逐页检查。'),
      );
    } finally {
      await call('closeDocument', doc.id);
    }
    finishTask('预览已生成');
  } catch (error) {
    finishTask('预览失败', error.message);
  } finally {
    state.busy = false;
  }
}

/** renderWatermarkResult 画操作结果。 */
function renderWatermarkResult(result, options) {
  const host = document.getElementById('watermark-result');
  if (!host) return;
  host.replaceChildren();

  const pages = result.pages === -1
    ? `全部 ${state.doc.pageCount} 页`
    : `${result.pages} 页`;
  const head = document.createElement('div');
  head.className = 'group-title';
  head.textContent = `已${watermarkActionLabel(options.action)}：${pages}，`
    + `${formatBytes(result.size)}`;
  host.append(head);

  // 签名警告必须显示在结果里而不是只留在任务条上：任务条会被下一次操作
  // 覆盖，而"这份产物的签名摘要可能已经失效"是需要用户拿去做决定的。
  for (const warning of result.warnings || []) {
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = warning;
    host.append(notice);
  }

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const download = actionButton('下载 OFD', downloadWatermarkResult);
  download.id = 'watermark-download';
  const preview = actionButton('载入预览', loadWatermarkResult);
  preview.className = 'ghost';
  actions.append(download, preview);
  host.append(actions);
  renderWatermarkInventory();
}

/** watermarkActionLabel 给出操作的中文名。 */
function watermarkActionLabel(action) {
  if (action === 'replace') return '替换水印';
  if (action === 'remove') return '删除水印';
  return '添加水印';
}

/** renderWatermarkInventory 列出当前文档已有哪些水印。 */
async function renderWatermarkInventory() {
  const host = document.getElementById('watermark-inventory');
  if (!host || !state.doc) return;
  let result;
  try {
    result = await call('watermarkInventory', state.doc.id);
  } catch (error) {
    host.replaceChildren(note(`读取水印清单失败：${error.message}`));
    return;
  }
  state.watermarkInventory = result.items;
  host.replaceChildren();
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = `文档现有水印（${result.items.length} 条）`;
  host.append(title);
  if (!result.items.length) {
    host.append(note('当前文档没有水印注解。'));
    return;
  }
  host.append(simpleTable(
    ['注解 ID', '页', '创建者', '修改日期', '备注', '尺寸 (mm)'],
    result.items.map((item) => [
      // ID 不是纯数字时按 ID 精确匹配用不了，界面要说清楚而不是给个不可点的 ID。
      item.numericID ? item.id : `${item.id}（无法按 ID 匹配）`,
      item.page + 1,
      item.creator || '—',
      item.lastModDate || '—',
      item.remark || '—',
      item.boundary ? `${item.boundary.width} × ${item.boundary.height}` : '—',
    ]),
  ));
}

/** renderWatermarkError 画出错误。 */
function renderWatermarkError(message) {
  const host = document.getElementById('watermark-result');
  if (!host) return;
  host.replaceChildren();
  const notice = document.createElement('div');
  notice.className = 'notice is-error';
  notice.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = '水印操作失败';
  notice.append(title, document.createTextNode(message));
  host.append(notice);
}

/** downloadWatermarkResult 下载水印产物。 */
function downloadWatermarkResult() {
  const result = state.watermarkResult;
  if (!result) return;
  downloadBlob(result.blob, result.name);
}

/** loadWatermarkResult 把水印产物载入文件队列。 */
async function loadWatermarkResult() {
  const result = state.watermarkResult;
  if (!result) return;
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  const file = new File([bytes], result.name, {
    type: 'application/ofd',
  });
  await addFiles([file]);
}

// ——— 表单控件 ———

/** textField 画一个文本输入。 */
function textField(id, label, value) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const name = document.createElement('span');
  name.className = 'field-label';
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = `wm-${id}`;
  input.value = value;
  input.addEventListener('input', readWatermarkOptions);
  wrap.append(name, input);
  return wrap;
}

/** numberField 画一个数字输入。 */
function numberField(id, label, value, min, max, step) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const name = document.createElement('span');
  name.className = 'field-label';
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.id = `wm-${id}`;
  input.value = value;
  input.min = min;
  input.max = max;
  input.step = step || 1;
  input.addEventListener('input', readWatermarkOptions);
  wrap.append(name, input);
  return wrap;
}

/** rangeField 画一个滑块。 */
function rangeField(id, label, value, minLabel, maxLabel) {
  const wrap = document.createElement('div');
  wrap.className = 'field wm-range';
  const head = document.createElement('span');
  head.className = 'field-label';
  head.textContent = label;
  const output = document.createElement('output');
  output.textContent = String(value);
  head.append(output);
  const input = document.createElement('input');
  input.type = 'range';
  input.id = `wm-${id}`;
  input.min = 0;
  input.max = 255;
  input.step = 1;
  input.value = value;
  input.addEventListener('input', () => {
    output.textContent = input.value;
    readWatermarkOptions();
  });
  const scale = document.createElement('div');
  scale.className = 'wm-scale';
  const low = document.createElement('span');
  low.textContent = minLabel;
  const high = document.createElement('span');
  high.textContent = maxLabel;
  scale.append(low, high);
  wrap.append(head, input, scale);
  return wrap;
}

/** colorField 画一个颜色输入。 */
function colorField(id, label, value) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const name = document.createElement('span');
  name.className = 'field-label';
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'color';
  input.id = `wm-${id}`;
  input.value = value;
  input.addEventListener('input', readWatermarkOptions);
  wrap.append(name, input);
  return wrap;
}

/** selectField 画一个下拉框。 */
function selectField(id, label, choices, value) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const name = document.createElement('span');
  name.className = 'field-label';
  name.textContent = label;
  const select = document.createElement('select');
  select.id = `wm-${id}`;
  for (const choice of choices) {
    select.append(optionNode(choice.value, choice.label));
  }
  select.value = value;
  select.addEventListener('change', readWatermarkOptions);
  wrap.append(name, select);
  return wrap;
}

/** fileField 画一个文件选择。 */
function fileField(id, label) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const name = document.createElement('span');
  name.className = 'field-label';
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'file';
  input.id = `wm-${id}`;
  input.accept = 'image/png,image/jpeg';
  wrap.append(name, input);
  return wrap;
}

/** optionNode 造一个 option。 */
function optionNode(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

/** radioGroup 画一组单选按钮。 */
function radioGroup(name, choices, value, label) {
  const wrap = document.createElement('div');
  wrap.className = 'field wm-radio';
  if (label) {
    const title = document.createElement('span');
    title.className = 'field-label';
    title.textContent = label;
    wrap.append(title);
  }
  const group = document.createElement('div');
  group.className = 'wm-radio-group';
  for (const choice of choices) {
    const item = document.createElement('label');
    item.className = 'wm-radio-item';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `wm-${name}`;
    input.value = choice.value;
    input.checked = choice.value === value;
    input.addEventListener('change', readWatermarkOptions);
    const text = document.createElement('span');
    text.textContent = choice.label;
    item.append(input, text);
    if (choice.hint) {
      const hint = document.createElement('small');
      hint.textContent = choice.hint;
      item.append(hint);
    }
    group.append(item);
  }
  wrap.append(group);
  return wrap;
}

/** watermarkNote 是水印面板底部的说明。 */
function watermarkNote() {
  const box = document.createElement('div');
  box.className = 'wm-note';
  const paragraphs = [
    '加水印会改动页面内容，文档里已有签名的摘要随即失效。默认保留签名条目'
      + '并在结果里给出提示；也可在下方改成删除。',
    '文字水印的字体取自文档自身的字体表。若文档没有内嵌字体，'
      + '浏览器里可能画不出中文——此时改用图片水印，或先用「转换」把文档'
      + '内嵌好字体。',
    '替换与删除只影响所选页。若文档里的既有水印被标记为只读，'
      + '需要勾上"忽略只读标记"。',
  ];
  for (const text of paragraphs) {
    const node = document.createElement('p');
    node.className = 'hint';
    node.textContent = text;
    box.append(node);
  }
  const toggles = document.createElement('div');
  toggles.className = 'wm-toggles';
  toggles.append(
    checkboxField('skip-readonly', '忽略只读标记'),
    checkboxField('skip-permissions', '忽略文档的水印权限限制'),
  );
  const signatures = document.createElement('label');
  signatures.className = 'field';
  const name = document.createElement('span');
  name.className = 'field-label';
  name.textContent = '签名处理';
  const select = document.createElement('select');
  select.id = 'wm-signatures';
  select.append(
    optionNode('preserve', '保留（默认，会提示摘要可能失效）'),
    optionNode('drop', '删除签名条目'),
    optionNode('rewrite', '保留并重写包内路径（签名通常仍失效）'),
  );
  select.value = watermarkDefaults.signatures;
  select.addEventListener('change', readWatermarkOptions);
  signatures.append(name, select);
  box.append(signatures, toggles);

  const inventory = document.createElement('div');
  inventory.id = 'watermark-inventory';
  inventory.className = 'report-host';
  box.append(inventory);
  return box;
}

/** checkboxField 画一个复选框。id 会加上 wm- 前缀，与其余字段一致。 */
function checkboxField(id, label, checked = false) {
  const wrap = document.createElement('label');
  wrap.className = 'wm-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = `wm-${id}`;
  input.checked = checked;
  // 不在这里挂处理器：各面板的表单上已有 change 监听（水印同步字段、
  // 长期保存作废预检），靠事件冒泡统一处理。这里再挂一个 readWatermarkOptions
  // 既多余，又会让长期保存的勾选框去读水印参数。
  const text = document.createElement('span');
  text.textContent = label;
  wrap.append(input, text);
  return wrap;
}

// ——— 字体回退 ———

/**
 * 本机字体候选与注册状态。
 *
 * candidates 存的是 queryLocalFonts 返回的 FontData（不能展开，见 addLocalFonts），
 * registered 是已注册的族名集合，用来把候选标成"已注册"并禁用。
 */
const localFontState = { candidates: [], registered: new Set() };

/** syncFallbackFontCount 从 WASM 取回已注册字体数并同步到 state。 */
async function syncFallbackFontCount() {
  try {
    const listed = await call('listFallbackFonts');
    state.fallbackFontCount = listed.fonts.length;
  } catch (error) {
    // 取不到就保持原值：这只是决定要不要显示提示，不值得把操作判为失败。
  }
}

/** toggleFontPanel 开合字体面板。 */
function toggleFontPanel() {
  const panel = document.getElementById('font-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) refreshFontPanel();
}

/** refreshFontPanel 重画字体面板。 */
async function refreshFontPanel() {
  await renderFontDoc();
  await renderFontRegistry();
  // 候选列表按"是否已注册"标状态，注册或移除之后都要重画。
  if (localFontState.candidates.length) renderLocalFontCandidates();
}

/** renderFontDoc 列出当前文档声明的字体及其内嵌状态。 */
async function renderFontDoc() {
  const host = document.getElementById('font-doc');
  host.replaceChildren();
  const title = document.createElement('div');
  title.className = 'group-title';
  const fonts = (state.doc && state.doc.fonts) || [];
  if (!fonts.length) {
    title.textContent = '当前文档字体';
    host.append(title, note('未载入文档。'));
    return;
  }
  const embedded = fonts.filter((font) => font.embedded).length;
  title.textContent = `当前文档字体（${fonts.length} 个，内嵌 ${embedded} 个）`;
  host.append(title, simpleTable(
    ['字体', '内嵌', '样式'],
    fonts.map((font) => [
      font.name || font.family || '—',
      font.embedded ? '是' : '否',
      [font.bold ? '粗' : '', font.italic ? '斜' : ''].filter(Boolean).join(' ') || '常规',
    ]),
  ));
  const missing = fonts.filter((font) => !font.embedded).length;
  if (missing) {
    const warn = document.createElement('div');
    warn.className = 'notice';
    warn.textContent = `有 ${missing} 个字体没有内嵌文件。浏览器里没有系统字体，`
      + '这些文字在预览里画不出来，需要注册回退字体。';
    host.append(warn);
  }
}

/** renderFontRegistry 列出已注册的回退字体。 */
async function renderFontRegistry() {
  const host = document.getElementById('font-list');
  host.replaceChildren();
  let listed;
  try {
    listed = await call('listFallbackFonts');
  } catch (error) {
    host.append(note(`读取字体列表失败：${error.message}`));
    return;
  }
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = `已注册的回退字体（${listed.fonts.length} 个，`
    + `${formatBytes(listed.totalSize)}）`;
  host.append(title);

  if (!listed.fonts.length) {
    host.append(note('尚未注册回退字体。'));
    return;
  }
  const list = document.createElement('ul');
  list.className = 'font-items';
  for (const font of listed.fonts) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    const sourceLabel = font.source === 'local' ? '本机' : '上传';
    name.textContent = `${font.family}（${formatBytes(font.size)}，${sourceLabel}）`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.textContent = '移除';
    remove.addEventListener('click', () => removeFallbackFont(font.family));
    item.append(name, remove);
    list.append(item);
  }
  host.append(list);
  host.append(note('字体字节注册后留在引擎的全局表里，移除只让后续渲染不再使用它，'
    + '内存不会回落。'));
}

/** removeFallbackFont 移除一个回退字体族。 */
async function removeFallbackFont(family) {
  try {
    await call('removeFallbackFont', family);
    await syncFallbackFontCount();
    await refreshFontPanel();
    renderPreview();
  } catch (error) {
    showNotice(`移除字体失败：${error.message}`, true);
  }
}

// 字体族等价组，与渲染引擎的 fallbackNameGroup 保持一致。
// 文档声明「仿宋_GB2312」，本机装的是「FangSong」时，靠这张表才能对应上。
const fontFamilyGroups = {
  simsun: ['宋体', '宋体gb2312', 'simsun', 'nsimsun', 'songti', 'simsungb2312',
    'songtigb2312', '方正小标宋', '方正小标宋gbk', '方正书宋', 'fzxbs'],
  stsong: ['华文宋体', 'stsong'],
  simhei: ['黑体', '黑体gb2312', 'simhei', 'heiti', 'hei', 'microsoftheiti',
    'heitisc', '方正黑体', '方正黑体gbk'],
  stheiti: ['华文黑体', 'stheiti'],
  simkai: ['楷体', '楷体gb2312', 'simkai', 'kaiti', 'kaishu', 'kaitigb2312',
    '方正楷体', '方正楷体gbk'],
  stkaiti: ['华文楷体', 'stkaiti'],
  simfang: ['仿宋', '仿宋gb2312', 'simfang', 'fangsong', 'fangsonggb2312',
    '方正仿宋', '方正仿宋gbk'],
  stfangsong: ['华文仿宋', 'stfangsong'],
  yahei: ['微软雅黑', 'microsoftyahei', 'microsoftyaheiui', 'msyh', 'yahei'],
  jhenghei: ['微软正黑', 'microsoftjhenghei', 'microsoftjhengheiui', 'msjh'],
  dengxian: ['等线', 'dengxian'],
  sanssc: ['思源黑体', 'sourcehansanssc', 'sourcehansanscn', 'notosanssc',
    'notosanscjksc'],
  serifsc: ['思源宋体', 'sourcehanserifsc', 'sourcehanserifcn', 'notoserifsc',
    'notoserifcjksc'],
};

/** normalizeFontFamily 归一化族名用于比较：小写、去空白与样式后缀。 */
function normalizeFontFamily(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/(regular|bold|italic|light|medium|semibold|black|thin)$/g, '');
}

/** fontFamilyGroup 返回族名所属的等价组，未收录时返回空串。 */
function fontFamilyGroup(name) {
  const normalized = normalizeFontFamily(name);
  for (const [group, members] of Object.entries(fontFamilyGroups)) {
    if (members.includes(normalized)) return group;
  }
  return '';
}

/** localFontMatchesFamily 判断本机字体能否补齐文档声明的某个族。 */
function localFontMatchesFamily(localFamily, missing) {
  const localNorm = normalizeFontFamily(localFamily);
  const localGroup = fontFamilyGroup(localFamily);
  for (const [key, original] of missing) {
    if (key === localNorm) return original;
    if (localGroup) {
      const group = fontFamilyGroup(original);
      if (group && group === localGroup) return original;
    }
  }
  return '';
}

/** missingFontFamilies 收集文档声明但未内嵌的字体族（键归一化，值保留原名）。 */
function missingFontFamilies() {
  const families = new Map();
  for (const font of (state.doc && state.doc.fonts) || []) {
    if (!font || font.embedded) continue;
    const family = String(font.family || font.name || '').trim();
    if (!family) continue;
    families.set(normalizeFontFamily(family), family);
  }
  return families;
}

/**
 * addLocalFonts 用本机字体补齐文档缺的字体。
 *
 * 用本地字体访问 API，需要用户授权。只读取文档真正缺、且本机确有匹配的那些
 * 字体族：中文字体动辄十几 MB，把本机字体全读进来既慢又白占内存。
 */
async function addLocalFonts() {
  if (typeof window.queryLocalFonts !== 'function') {
    showNotice('当前浏览器不支持读取本机字体，请改用「上传字体文件」。');
    return;
  }
  const host = document.getElementById('font-candidates');
  host.replaceChildren(note('正在请求本机字体权限…'));
  let available;
  try {
    available = await window.queryLocalFonts();
  } catch (error) {
    // 权限被拒或被浏览器策略拦截都走这里，两种都要说清楚下一步。
    host.replaceChildren(note(
      `读取本机字体失败：${error.message}。可以改用「上传字体文件」。`));
    return;
  }

  // 只挑可能用得上的：与文档缺失字体同族，或名字像中文字体。
  // 纯西文字体画不出中文，列出来只会让用户白选一个十几 MB 的文件。
  const wanted = missingFontFamilies();
  const cjk = /cjk|han|hei|song|kai|ming|yahei|simsun|simhei|noto\s*sans\s*(sc|tc|jp|kr)|source\s*han|wenquanyi|pingfang|微软|宋体|黑体|楷体|仿宋|等线|苹方|思源|方正/i;
  const byFamily = new Map();
  for (const font of available || []) {
    const family = String((font && font.family) || '').trim();
    if (!family) continue;
    const matchesDoc = wanted.size
      && Boolean(localFontMatchesFamily(family, wanted));
    if (!matchesDoc && !cjk.test(family)) continue;
    // 同族只留一个，优先常规字重。
    const current = byFamily.get(family);
    if (!current || (font.style === 'Regular' && current.style !== 'Regular')) {
      // 不能把 FontData 展开（{...font}）：它的 family/fullName/style 是原型
      // 上的 getter，不是自有可枚举属性，展开得到的是空对象。把原对象整个
      // 存下来，族名另存一份。
      byFamily.set(family, { data: font, family, matchesDoc });
    }
  }

  localFontState.candidates = [...byFamily.values()]
    // 能补齐文档缺失字体的排前面，其余按名字排序。
    .sort((a, b) => (Number(b.matchesDoc) - Number(a.matchesDoc))
      || a.family.localeCompare(b.family));

  if (!localFontState.candidates.length) {
    // 候选为空时要给出结论，而不是留一片空白让人以为还没加载完。
    host.replaceChildren(note(
      '本机没有找到可用的中文字体，可以改用「上传字体文件」。'));
    return;
  }

  await refreshLocalFontRegistered();
  renderLocalFontCandidates();
}

/** refreshLocalFontRegistered 记录已经注册过的字体族，用于把候选标成"已注册"。 */
async function refreshLocalFontRegistered() {
  try {
    const listed = await call('listFallbackFonts');
    localFontState.registered = new Set(listed.fonts.map((font) => font.family));
  } catch (error) {
    // 取不到就当没有已注册的：最多是重复注册，注册本身是幂等的。
  }
}

/**
 * renderLocalFontCandidates 画本机字体候选。
 *
 * 多选而不是逐个点击：一份文档常常同时缺宋体、黑体、楷体，逐个注册要来回
 * 点很多次。与文档缺失字体同族的默认勾上，用户确认一次就能补齐。
 */
function renderLocalFontCandidates() {
  const host = document.getElementById('font-candidates');
  if (!host) return;
  const candidates = localFontState.candidates;
  host.replaceChildren();
  if (!candidates.length) return;

  const wanted = missingFontFamilies();
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = `本机字体（共 ${candidates.length} 个）`;
  const hint = wanted.size
    ? '标「可补齐」的与文档缺失字体同族，已默认勾选；勾一个还是几个都行。'
    : '中文字体通常十几 MB，选一个能覆盖文档用字的即可。';
  host.append(title, note(hint));

  const list = document.createElement('ul');
  list.className = 'font-items';
  candidates.forEach((entry, index) => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'font-pick';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.index = String(index);
    const registered = localFontState.registered.has(entry.family);
    box.disabled = registered;
    // 与文档同族且尚未注册的默认勾上。
    box.checked = entry.matchesDoc && !registered;
    box.addEventListener('change', updateRegisterSelectedLabel);
    const name = document.createElement('span');
    // fullName 同样是原型 getter，可以直接读，但不能展开。
    name.textContent = (entry.data.fullName || entry.family)
      + (entry.matchesDoc ? '（可补齐）' : '')
      + (registered ? '（已注册）' : '');
    label.append(box, name);
    item.append(label);
    list.append(item);
  });
  host.append(list);

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const selectMatched = actionButton('全选可补齐', () => {
    setCandidateChecks((entry) => entry.matchesDoc);
  });
  selectMatched.className = 'ghost';
  const clear = actionButton('全不选', () => setCandidateChecks(() => false));
  clear.className = 'ghost';
  const register = actionButton('注册所选', registerSelectedLocalFonts);
  register.id = 'font-register-selected';
  actions.append(selectMatched, clear, register);
  host.append(actions);
  updateRegisterSelectedLabel();
}

/** setCandidateChecks 按条件重设所有可勾选候选的勾选状态。 */
function setCandidateChecks(predicate) {
  const host = document.getElementById('font-candidates');
  if (!host) return;
  for (const box of host.querySelectorAll('input[type="checkbox"]')) {
    if (box.disabled) continue;
    const entry = localFontState.candidates[Number(box.dataset.index)];
    if (entry) box.checked = predicate(entry);
  }
  updateRegisterSelectedLabel();
}

/** selectedLocalFonts 取出当前勾选的候选。 */
function selectedLocalFonts() {
  const host = document.getElementById('font-candidates');
  if (!host) return [];
  return [...host.querySelectorAll('input[type="checkbox"]')]
    .filter((box) => box.checked && !box.disabled)
    .map((box) => localFontState.candidates[Number(box.dataset.index)])
    .filter(Boolean);
}

/** updateRegisterSelectedLabel 让按钮显示将注册的数量。 */
function updateRegisterSelectedLabel() {
  const button = document.getElementById('font-register-selected');
  if (!button) return;
  const count = selectedLocalFonts().length;
  button.textContent = count ? `注册所选（${count}）` : '注册所选';
  button.disabled = count === 0;
}

/**
 * registerSelectedLocalFonts 批量注册勾选的本机字体。
 *
 * 逐个替换成"正在注册 x/y"而不是一次性发出去：中文字体十几 MB，
 * 读取与解析都要时间，没有进度会看起来像卡死。
 */
async function registerSelectedLocalFonts() {
  const host = document.getElementById('font-candidates');
  const entries = selectedLocalFonts();
  if (!entries.length) {
    showNotice('请先勾选要注册的字体。');
    return;
  }

  const failures = [];
  let registered = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (host) {
      host.replaceChildren(note(
        `正在注册 ${index + 1}/${entries.length}：${entry.data.fullName || entry.family}…`));
    }
    try {
      const blob = await entry.data.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const weight = entry.data.style === 'Bold' ? 700 : 400;
      const italic = String(entry.data.style || '').includes('Italic');
      await call('addFallbackFont', bytes, entry.family, weight, italic, 'local');
      localFontState.registered.add(entry.family);
      registered++;
    } catch (error) {
      // 单个字体失败不挡住其余：能补一个是一个。
      failures.push(`${entry.family}：${error.message}`);
    }
  }

  await syncFallbackFontCount();
  await refreshFontPanel();
  renderPreview();
  if (failures.length) {
    showNotice(`有 ${failures.length} 个字体注册失败：${failures.join('；')}`, true);
  } else {
    showNotice(`已注册 ${registered} 个本机字体，预览会立即生效。`);
  }
}

/** uploadFallbackFonts 从文件注册回退字体。 */
async function uploadFallbackFonts(files) {
  const host = document.getElementById('font-list');
  if (!files.length) return;
  let done = 0;
  const failures = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // 文件名当族名：selectFallback 先按名字匹配，文件名通常就是字体名
      // （simsun.ttc、方正小标宋.ttf），匹配得上会优先用这一份；
      // 匹配不上也没关系，它仍会作为兜底被选中。
      const family = file.name.replace(/\.[^.]+$/, '');
      await call('addFallbackFont', bytes, family, 400, false, 'upload');
      done++;
    } catch (error) {
      failures.push(`${file.name}：${error.message}`);
    }
  }
  await syncFallbackFontCount();
  await refreshFontPanel();
  renderPreview();
  if (failures.length) {
    host.replaceChildren(note(`有 ${failures.length} 个文件未能注册：${failures.join('；')}`));
  } else if (done) {
    showNotice(`已注册 ${done} 个字体文件，预览会用它渲染缺字体的文字。`);
  }
}

// ——— 合并 ———

/**
 * 合并方式。
 *
 * 两条路径的产物形态完全不同，用户必须能分清：
 *   - ZIP 级把每个输入搬成独立的文档体，产出一个"多文档包"，阅读器里表现为
 *     一个文件含多份文档；被引用文件的字节不变，签名摘要仍有效。
 *   - 模型级把页面解析后重新拼成一个单文档 OFD，能跨文档选页、重排，但会
 *     重建文档级资源。
 * 选错了会拿到一个"打开发现结构不对"的文件。
 */
const mergeModes = [
  {
    value: 'zip',
    label: '整体合并（ZIP 级）',
    hint: '每个输入各成一个文档体，改动最小，保留原有资源与签名摘要。',
  },
  {
    value: 'pages',
    label: '拼页（模型级）',
    hint: '把页面拼成一个单文档，可跨文档选页、重排，会重建资源编号。',
  },
];

/** buildMergePanel 搭出合并面板骨架。 */
function buildMergePanel(host) {
  host.replaceChildren();
  host.dataset.built = '1';

  // 首次进入时把队列里的 OFD 全部选入，用户多半就是想合并它们。
  if (!state.mergeInputs.length) addAllMergeInputs();

  const body = document.createElement('div');
  body.className = 'merge-body';
  body.append(mergeInputList(), mergeOptionForm());

  const notices = document.createElement('div');
  notices.id = 'merge-notices';

  const result = document.createElement('div');
  result.id = 'merge-result';
  result.className = 'report-host';

  host.append(body, mergeActions(), notices, result, mergeNote());

  // 先插入 DOM 再渲染列表：renderMergeInputs 与 syncMergeFields 都按 id /
  // 选择器回查节点，还挂在局部变量上时回查拿到 null，列表会是空的。
  renderMergeInputs();
  syncMergeFields();
}

/** mergeInputList 画输入文件列表。 */
function mergeInputList() {
  const box = document.createElement('div');
  box.className = 'merge-inputs';
  const title = document.createElement('div');
  title.className = 'group-title';
  title.id = 'merge-inputs-title';
  box.append(title);
  const list = document.createElement('ul');
  list.className = 'merge-list';
  list.id = 'merge-list';
  box.append(list);
  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const all = actionButton('加入全部 OFD', () => {
    addAllMergeInputs();
    renderMergeInputs();
  });
  all.className = 'ghost';
  all.id = 'merge-add-all';
  const clear = actionButton('清空', () => {
    state.mergeInputs = [];
    renderMergeInputs();
  });
  clear.className = 'ghost';
  actions.append(all, clear);
  box.append(actions);
  return box;
}

/** addAllMergeInputs 把队列里的 OFD 文件加入合并列表。 */
function addAllMergeInputs() {
  const picked = new Set(state.mergeInputs);
  for (const file of state.files) {
    if (!file.name.toLowerCase().endsWith('.ofd')) continue;
    if (picked.has(file.id)) continue;
    state.mergeInputs.push(file.id);
    picked.add(file.id);
  }
}

/** renderMergeInputs 重画输入列表。 */
function renderMergeInputs() {
  const list = document.getElementById('merge-list');
  const title = document.getElementById('merge-inputs-title');
  if (!list || !title) return;
  list.replaceChildren();

  // 队列可能已被清空或换过，去掉已经不存在的 ID。
  state.mergeInputs = state.mergeInputs.filter((id) =>
    state.files.some((file) => file.id === id));

  title.textContent = `输入（按顺序合并，共 ${state.mergeInputs.length} 个）`;
  if (!state.mergeInputs.length) {
    list.append(note('还没有输入。把 OFD 加入文件队列，或点「加入全部 OFD」。'));
    syncMergeFields();
    return;
  }

  state.mergeInputs.forEach((id, index) => {
    const file = state.files.find((item) => item.id === id);
    if (!file) return;
    const item = document.createElement('li');
    item.className = 'merge-item';

    const order = document.createElement('span');
    order.className = 'merge-order';
    order.textContent = String(index + 1);

    const name = document.createElement('span');
    name.className = 'merge-name';
    name.textContent = file.name;
    name.title = file.name;

    const meta = document.createElement('span');
    meta.className = 'merge-meta';
    meta.textContent = [
      formatBytes(file.size),
      file.doc ? `${file.doc.pageCount} 页` : '',
      file.doc && file.doc.stats ? `${file.doc.stats.signatures} 签名` : '',
    ].filter(Boolean).join(' · ');

    const up = iconButton('↑', '上移', () => moveMergeInput(index, -1));
    const down = iconButton('↓', '下移', () => moveMergeInput(index, 1));
    const remove = iconButton('✕', '移除', () => {
      state.mergeInputs.splice(index, 1);
      renderMergeInputs();
    });
    up.disabled = index === 0;
    down.disabled = index === state.mergeInputs.length - 1;

    item.append(order, name, meta, up, down, remove);
    list.append(item);
  });
  syncMergeFields();
}

/** iconButton 画一个紧凑的图标按钮。 */
function iconButton(label, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost merge-icon';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', onClick);
  return button;
}

/** moveMergeInput 调整某个输入的位置。 */
function moveMergeInput(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.mergeInputs.length) return;
  const [moved] = state.mergeInputs.splice(index, 1);
  state.mergeInputs.splice(target, 0, moved);
  renderMergeInputs();
}

/** mergeOptionForm 画合并参数。 */
function mergeOptionForm() {
  const form = document.createElement('div');
  form.className = 'wm-form merge-form';
  form.addEventListener('change', syncMergeFields);

  const mode = document.createElement('div');
  mode.className = 'wm-kind';
  mode.append(radioGroup('merge-mode', mergeModes, 'zip', '合并方式'));
  form.append(mode);

  const zipBox = document.createElement('div');
  zipBox.className = 'wm-fields';
  zipBox.id = 'merge-zip-fields';
  zipBox.append(
    selectField('merge-signatures', '签名处理', [
      { value: 'preserve', label: '保留（默认，摘要仍有效）' },
      { value: 'rewrite', label: '保留并重写包内路径（签名值失效）' },
      { value: 'drop', label: '删除签名条目' },
    ], 'preserve'),
    selectField('merge-orphans', '目录外条目', [
      { value: 'error', label: '报错（默认）' },
      { value: 'preserve', label: '保留到根目录' },
      { value: 'ignore', label: '跳过' },
    ], 'error'),
    selectField('merge-compression', '压缩策略', [
      { value: 'auto', label: '自动（默认）' },
      { value: 'deflate', label: '全部 Deflate' },
      { value: 'store', label: '不压缩' },
    ], 'auto'),
  );
  form.append(zipBox);

  const pagesBox = document.createElement('div');
  pagesBox.className = 'wm-fields';
  pagesBox.id = 'merge-pages-fields';
  pagesBox.append(
    textField('merge-pages', '页序（留空为全部页面）', ''),
    textField('merge-title', '标题（留空沿用首个）', ''),
    textField('merge-author', '作者（留空沿用首个）', ''),
  );
  form.append(pagesBox);

  const shared = document.createElement('div');
  shared.className = 'wm-fields';
  shared.append(
    numberField('merge-compression-level', '压缩级别（0 自动，1–9）', 0, 0, 9, 1),
    checkboxField('merge-deterministic', '确定性输出（可复现，便于比对）'),
  );
  form.append(shared);
  return form;
}

/** mergeActions 画执行按钮行。 */
function mergeActions() {
  const row = document.createElement('div');
  row.className = 'tool-actions';
  const run = actionButton('开始合并', runMerge);
  run.id = 'merge-start';
  row.append(run);
  return row;
}

/** syncMergeFields 按合并方式切换参数显隐。 */
function syncMergeFields() {
  const form = document.querySelector('.merge-form');
  if (!form) return;
  const picked = [...form.querySelectorAll('input[name="wm-merge-mode"]')]
    .find((node) => node.checked);
  const mode = picked ? picked.value : 'zip';
  const zip = document.getElementById('merge-zip-fields');
  const pages = document.getElementById('merge-pages-fields');
  if (zip) zip.hidden = mode !== 'zip';
  if (pages) pages.hidden = mode !== 'pages';
  const run = document.getElementById('merge-start');
  if (run) run.disabled = state.mergeInputs.length < 2 || state.busy;
  return mode;
}

/** readMergeOptions 汇总参数。 */
function readMergeOptions() {
  const value = (id, fallback) => {
    const node = document.getElementById(id);
    return node ? node.value : fallback;
  };
  const form = document.querySelector('.merge-form');
  const picked = form
    ? [...form.querySelectorAll('input[name="wm-merge-mode"]')]
      .find((node) => node.checked)
    : null;
  return {
    mode: picked ? picked.value : 'zip',
    signatures: value('wm-merge-signatures', 'preserve'),
    orphans: value('wm-merge-orphans', 'error'),
    compression: value('wm-merge-compression', 'auto'),
    compressionLevel: Number(value('wm-merge-compression-level', 0)),
    deterministic: Boolean(document.getElementById('wm-merge-deterministic')?.checked),
    pages: value('wm-merge-pages', ''),
    title: value('wm-merge-title', ''),
    author: value('wm-merge-author', ''),
  };
}

/** runMerge 执行一次合并。 */
async function runMerge() {
  if (state.busy) return;
  const options = readMergeOptions();
  if (state.mergeInputs.length < 2) {
    showNotice('合并至少需要两个 OFD 文档。');
    return;
  }

  state.busy = true;
  setTask('读取输入', 0, true);
  const notices = document.getElementById('merge-notices');
  if (notices) notices.replaceChildren();

  try {
    // 浏览器里没有文件系统，输入只能整体读成字节再送进 WASM。
    // 逐个读、逐个报进度，几十 MB 的文件才不会看着像卡死。
    const inputs = [];
    const names = [];
    for (let index = 0; index < state.mergeInputs.length; index++) {
      const file = state.files.find((item) => item.id === state.mergeInputs[index]);
      if (!file) continue;
      setTask(`读取输入 ${index + 1}/${state.mergeInputs.length}`, 0, true, file.name);
      const buffer = await file.file.arrayBuffer();
      inputs.push(new Uint8Array(buffer));
      names.push(file.name);
    }
    if (inputs.length < 2) throw new Error('可读取的输入不足两个');

    setTask('合并中', 0, true);
    const result = await convert({ command: 'merge', ...options, inputs, names }, null);
    state.mergeResult = result;
    renderMergeResult(result, options);
    finishTask('完成');
  } catch (error) {
    renderMergeError(error.message);
    finishTask('合并失败', error.message);
  } finally {
    state.busy = false;
    syncMergeFields();
  }
}

/** renderMergeResult 画合并结果。 */
function renderMergeResult(result, options) {
  const host = document.getElementById('merge-result');
  if (!host) return;
  host.replaceChildren();

  const modeLabel = options.mode === 'pages' ? '拼页（模型级）' : '整体合并（ZIP 级）';
  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = `已合并 ${result.inputs} 个文档 · ${modeLabel} · ${formatBytes(result.size)}`;
  host.append(title);

  for (const warning of result.warnings || []) {
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = warning;
    host.append(notice);
  }

  const events = result.signatureEvents || [];
  if (events.length) {
    // 签名怎么处理必须逐条列出来：ZIP 级合并会重写包内路径，签名值失效是
    // 常见结果，用户需要知道产物里的签名还能不能验。
    host.append(simpleTable(
      ['来源', '签名', '处理'],
      events.map((event) => [event.input, event.id, event.actionLabel]),
    ));
  }

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const download = actionButton('下载 OFD', downloadMergeResult);
  download.id = 'merge-download';
  const load = actionButton('载入预览', loadMergeResult);
  load.className = 'ghost';
  actions.append(download, load);
  host.append(actions);
}

/** renderMergeError 画合并失败。 */
function renderMergeError(message) {
  const host = document.getElementById('merge-result');
  if (!host) return;
  host.replaceChildren();
  const notice = document.createElement('div');
  notice.className = 'notice is-error';
  const title = document.createElement('strong');
  title.textContent = '合并失败';
  notice.append(title, document.createTextNode(message));
  host.append(notice);
}

/** downloadMergeResult 下载合并产物。 */
function downloadMergeResult() {
  const result = state.mergeResult;
  if (!result) return;
  downloadBlob(result.blob, result.name);
}

/** loadMergeResult 把合并产物载入文件队列。 */
async function loadMergeResult() {
  const result = state.mergeResult;
  if (!result) return;
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  await addFiles([new File([bytes], result.name, { type: 'application/ofd' })]);
}

/** mergeNote 是合并面板底部的说明。 */
function mergeNote() {
  const box = document.createElement('div');
  box.className = 'wm-note';
  for (const text of [
    '整体合并把每个输入原样搬成独立文档体，产物是一个多文档 OFD；'
      + '拼页把页面抽出来合成单文档，可跨文档选页与重排。',
    '页序写法：s2:1;s1:3-5 表示"第 2 个输入的第 1 页，再第 1 个输入的第 3 到 5 页"；'
      + '只写 1,3-5 则按拼接后的全局页序选。',
    '整体合并会重写包内路径，被引用文件的字节不变，签名摘要仍然有效，'
      + '但签名值覆盖了签名清单，路径一改就需要重新签章。',
  ]) {
    const node = document.createElement('p');
    node.className = 'hint';
    node.textContent = text;
    box.append(node);
  }
  return box;
}

// ——— 长期保存 ———

/**
 * preserveProfiles 是下拉可选的 profile。
 *
 * 默认 OFD-A 而不是"自动"：这个工具的用途就是把文档转成档案长期保存格式，
 * 而多数文件声明的还是基础 OFD。"自动"会照着文件声明走，对基础 OFD 结果是
 * "没有任何改动"，用户会以为工具坏了。空串表示按文件声明自动判定。
 */
const preserveProfiles = [
  { value: 'OFD-A', label: 'OFD-A（GB/T 42133 档案长期保存）' },
  { value: 'OFD-H', label: 'OFD-H（电子病历）' },
  { value: '', label: '自动（按文件声明的 DocType）' },
];

/** buildPreservePanel 搭出长期保存面板骨架。 */
function buildPreservePanel(host) {
  host.replaceChildren();
  host.dataset.built = '1';

  const form = document.createElement('div');
  form.className = 'wm-form preserve-form';
  form.addEventListener('change', () => {
    // 改了参数，之前的预检结果就不再对应当前设置了，清掉避免误读。
    invalidatePreservePlan();
  });
  form.append(
    selectField('preserve-profile', '档案 profile', preserveProfiles, 'OFD-A'),
  );
  const toggles = document.createElement('div');
  toggles.className = 'wm-fields';
  toggles.append(
    checkboxField('preserve-validate', '写出前校验（确认转换没有引入新问题）', true),
    checkboxField('preserve-drop', '删除无人引用的条目（不可逆）'),
  );
  form.append(toggles);

  const notices = document.createElement('div');
  notices.id = 'preserve-notices';

  const plan = document.createElement('div');
  plan.id = 'preserve-plan';
  plan.className = 'report-host';

  const result = document.createElement('div');
  result.id = 'preserve-result';
  result.className = 'report-host';

  host.append(form, preserveActions(), notices, plan, result, preserveNote());
  syncPreserveFields();
}

/** preserveActions 画预检与执行按钮。 */
function preserveActions() {
  const row = document.createElement('div');
  row.className = 'tool-actions';
  const plan = actionButton('预检', runPreservePlan);
  plan.id = 'preserve-plan-button';
  const apply = actionButton('执行', runPreserveApply);
  apply.id = 'preserve-apply';
  row.append(plan, apply);
  return row;
}

/** syncPreserveFields 按开关切换提示。 */
function syncPreserveFields() {
  const drop = document.getElementById('wm-preserve-drop');
  const hint = document.getElementById('preserve-drop-hint');
  if (hint) hint.hidden = !(drop && drop.checked);
  const apply = document.getElementById('preserve-apply');
  if (apply) apply.disabled = !state.doc;
  const plan = document.getElementById('preserve-plan-button');
  if (plan) plan.disabled = !state.doc;
}

/** invalidatePreservePlan 作废已展示的预检结果。 */
function invalidatePreservePlan() {
  state.preservePlanResult = null;
  const host = document.getElementById('preserve-plan');
  if (host) host.replaceChildren();
  syncPreserveFields();
}

/** readPreserveOptions 汇总参数。 */
function readPreserveOptions() {
  const value = (id, fallback) => {
    const node = document.getElementById(id);
    return node ? node.value : fallback;
  };
  return {
    docType: value('wm-preserve-profile', 'OFD-A'),
    validate: Boolean(document.getElementById('wm-preserve-validate')?.checked),
    dropUnreferenced: Boolean(document.getElementById('wm-preserve-drop')?.checked),
  };
}

/** preservePayload 组装给 WASM 的请求。 */
function preservePayload(options) {
  return {
    documentId: state.doc.id,
    docType: options.docType,
    validate: options.validate,
    dropUnreferenced: options.dropUnreferenced,
  };
}

/** runPreservePlan 预检：算出计划改动，不产出文件。 */
async function runPreservePlan() {
  if (!state.doc || state.busy) return;
  const options = readPreserveOptions();
  state.busy = true;
  finishPrepare();
  setTask('预检中', 0, true);
  try {
    const response = await call('preservePlan', preservePayload(options));
    state.preservePlanResult = { options, result: response.result };
    renderPreservePlan(response.result, response.warnings, options, false);
    finishTask('预检完成');
  } catch (error) {
    renderPreservePlanError(error.message);
    finishTask('预检失败', error.message);
  } finally {
    state.busy = false;
    syncPreserveFields();
  }
}

/** finishPrepare 清掉上一次的产物提示，避免和新的预检结果并排。 */
function finishPrepare() {
  const result = document.getElementById('preserve-result');
  if (result) result.replaceChildren();
  state.preserveResult = null;
}

/**
 * runPreserveApply 执行转换。
 *
 * 删除无人引用条目是不可逆的，因此在没有预检结果时先强制预检一次，
 * 把"会删什么"摆到用户面前，要求再点一次才真正执行。
 */
async function runPreserveApply() {
  if (!state.doc || state.busy) return;
  const options = readPreserveOptions();

  const planned = state.preservePlanResult
    && JSON.stringify(state.preservePlanResult.options) === JSON.stringify(options);
  if (options.dropUnreferenced && !planned) {
    await runPreservePlan();
    showNotice('即将删除无人引用的条目，删除不可逆。确认上面的清单后再次点击「执行」。');
    return;
  }

  state.busy = true;
  setTask('转换中', 0, true);
  const notices = document.getElementById('preserve-notices');
  if (notices) notices.replaceChildren();
  try {
    const response = await convert({ command: 'preserve', ...preservePayload(options) }, null);
    state.preserveResult = response;
    renderPreserveResult(response, options);
    finishTask('转换完成');
  } catch (error) {
    renderPreservePlanError(error.message);
    finishTask('转换失败', error.message);
  } finally {
    state.busy = false;
    syncPreserveFields();
  }
}

/** renderPreservePlan 画预检结果。 */
function renderPreservePlan(result, warnings, options, applied) {
  const host = document.getElementById('preserve-plan');
  if (!host) return;
  host.replaceChildren();

  const title = document.createElement('div');
  title.className = 'group-title';
  title.textContent = applied
    ? `已执行 · ${result.docType}`
    : `预检结果 · ${result.docType}（未写出文件）`;
  host.append(title);

  for (const warning of warnings || []) {
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = warning;
    host.append(notice);
  }

  if (!result.changes.length) {
    // 说清"为什么没改动"。多半是选到了基础 OFD，而它本就不承诺满足该标准。
    host.append(note(result.docType === 'OFD'
      ? '这次转换没有需要改动的节点：该文件声明的是基础 OFD（DocType=OFD），'
        + '不承诺满足 GB/T 42133。把 profile 改成 OFD-A 才会施加档案转换。'
      : '这次转换没有需要改动的节点。'));
  } else {
    host.append(simpleTable(
      ['包内路径', '条款', '改动', '处数'],
      result.changes.map((change) => [
        change.entry || '—', change.clause || '—', change.action, change.count,
      ]),
    ));
  }
  host.append(unreferencedBlock(result, options, applied));
}

/** unreferencedBlock 画无人引用条目的处置说明。 */
function unreferencedBlock(result, options, applied) {
  const box = document.createElement('div');
  if (!result.unreferenced.length) {
    box.append(note('没有无人引用的条目。'));
    return box;
  }
  const notice = document.createElement('div');
  const count = result.unreferenced.length;
  if (result.closureIncomplete) {
    // 闭包不完整时库会拒绝删除，界面要说清"为什么没删"，否则用户会以为
    // 勾了删除却无效。
    notice.className = 'notice is-error';
    notice.textContent = `发现 ${count} 个无人引用的条目，但引用闭包不完整，`
      + `为避免误删不会删除：${result.closureReason}`;
  } else if (applied && result.unreferencedDropped > 0) {
    // 只有执行过才谈"已删除"。预检阶段库也会把这个字段填上（见下），
    // 照着它显示会把"计划删 1 个"说成"已删 1 个"。
    notice.className = 'notice is-ok';
    notice.textContent = `已删除 ${result.unreferencedDropped} 个无人引用的条目（GB/T 42133 6.2.1 c)）。`;
  } else if (options && options.dropUnreferenced) {
    notice.className = 'notice';
    notice.textContent = `将删除 ${count} 个无人引用的条目（GB/T 42133 6.2.1 c)）。删除不可逆。`;
  } else {
    notice.className = 'notice';
    notice.textContent = `有 ${count} 个无人引用的条目，当前只报告不删除；`
      + '勾选「删除无人引用的条目」后执行才会删。';
  }
  box.append(notice);
  // 清单可能很长，折叠展示。
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `查看 ${count} 个条目的路径`;
  const list = document.createElement('ul');
  list.className = 'preserve-list';
  for (const entry of result.unreferenced) {
    const item = document.createElement('li');
    item.textContent = entry;
    list.append(item);
  }
  details.append(summary, list);
  box.append(details);
  return box;
}

/** renderPreserveResult 画执行结果。 */
function renderPreserveResult(response, options) {
  renderPreservePlan(response.result, response.warnings, options, true);
  const host = document.getElementById('preserve-result');
  if (!host) return;
  host.replaceChildren();

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const download = actionButton('下载 OFD', downloadPreserveResult);
  download.id = 'preserve-download';
  const load = actionButton('载入预览', loadPreserveResult);
  load.className = 'ghost';
  actions.append(download, load);
  host.append(actions);
}

/** renderPreservePlanError 画失败提示。 */
function renderPreservePlanError(message) {
  const host = document.getElementById('preserve-plan');
  if (!host) return;
  host.replaceChildren();
  const notice = document.createElement('div');
  notice.className = 'notice is-error';
  const title = document.createElement('strong');
  title.textContent = '长期保存转换失败';
  notice.append(title, document.createTextNode(message));
  host.append(notice);
}

/** downloadPreserveResult 下载产物。 */
function downloadPreserveResult() {
  const result = state.preserveResult;
  if (!result) return;
  downloadBlob(result.blob, result.name);
}

/** loadPreserveResult 把产物载入文件队列。 */
async function loadPreserveResult() {
  const result = state.preserveResult;
  if (!result) return;
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  await addFiles([new File([bytes], result.name, { type: 'application/ofd' })]);
}

/** preserveNote 是长期保存面板底部的说明。 */
function preserveNote() {
  const box = document.createElement('div');
  box.className = 'wm-note';
  for (const text of [
    '依据 GB/T 42133—2022 第 6 章，把档案长期保存要求的转换动作施加到文档上：'
      + '去除权限声明、视图首选项、扩展信息，以及非文档内跳转的动作。',
    '转换只产出新文件，输入文档不受影响。基础 OFD（DocType=OFD）不承诺满足该标准，'
      + '选它不会产生任何改动。',
    '「删除无人引用的条目」是唯一不可逆的动作，默认只报告不删除；'
      + '勾选后执行前会先强制预检一次。',
  ]) {
    const node = document.createElement('p');
    node.className = 'hint';
    node.textContent = text;
    box.append(node);
  }
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.id = 'preserve-drop-hint';
  hint.hidden = true;
  hint.textContent = '已开启删除：执行前会先列出将删除的条目，需要再点一次「执行」确认。';
  box.append(hint);
  return box;
}
