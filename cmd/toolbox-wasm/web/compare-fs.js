// compare.CompareFiles 当前只接收路径。把本次输入挂成只读内存文件，供 Go
// 的 os.Stat / os.Open / ReadAt 使用；不落盘，不修改 wasm_exec.js。
(() => {
  const fs = globalThis.fs;
  const files = new Map();
  const handles = new Map();
  let nextMount = 1;
  let nextFD = 1000000;
  let lastYield = 0;
  const prefix = '/__toolbox_compare__/';
  const failure = (code) => Object.assign(new Error(code), { code });
  const stats = (data) => ({
    dev: 0, ino: 0, mode: 0o100444, nlink: 1, uid: 0, gid: 0, rdev: 0,
    size: data.byteLength, blksize: 4096, blocks: Math.ceil(data.byteLength / 512),
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0,
    isDirectory: () => false,
  });

  for (const method of ['stat', 'lstat', 'open']) {
    const original = fs[method].bind(fs);
    fs[method] = (path, ...args) => {
      if (typeof path !== 'string' || !path.startsWith(prefix)) return original(path, ...args);
      const callback = args[args.length - 1];
      const data = files.get(path);
      if (!data) return callback(failure('ENOENT'));
      if (method !== 'open') return callback(null, stats(data));
      // Go 的 O_RDONLY 为 0；该挂载点不提供任何写接口。
      if (args[0] !== 0) return callback(failure('EROFS'));
      const fd = nextFD++;
      handles.set(fd, { path, data, position: 0 });
      callback(null, fd);
    };
  }
  for (const method of ['fstat', 'read', 'close']) {
    const original = fs[method].bind(fs);
    fs[method] = (fd, ...args) => {
      const handle = handles.get(fd);
      if (!handle) return original(fd, ...args);
      const callback = args[args.length - 1];
      if (method === 'fstat') return callback(null, stats(handle.data));
      if (method === 'close') {
        handles.delete(fd);
        return callback(null);
      }
      const [buffer, offset, length, position] = args;
      const start = position === null ? handle.position : position;
      const size = Math.max(0, Math.min(length, handle.data.byteLength - start));
      buffer.set(handle.data.subarray(start, start + size), offset);
      if (position === null) handle.position += size;
      // 定期归还事件循环，让 Worker 能接收取消请求。
      if (performance.now() - lastYield > 16) {
        lastYield = performance.now();
        setTimeout(() => callback(null, size, buffer), 0);
      } else {
        callback(null, size, buffer);
      }
    };
  }

  globalThis.toolboxCompareFS = {
    mount(inputs) {
      if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 64) {
        throw new Error('比较需要 2–64 个 OFD 文件');
      }
      let total = 0;
      for (const input of inputs) {
        if (!(input instanceof Uint8Array) || !input.byteLength) {
          throw new Error('比较输入必须为非空 Uint8Array');
        }
        total += input.byteLength;
      }
      if (total > 256 * 1024 * 1024) throw new Error('比较输入总大小不能超过 256 MB');
      const root = `${prefix}${nextMount++}/`;
      const paths = inputs.map((data, index) => {
        const path = `${root}${index}.ofd`;
        files.set(path, data);
        return path;
      });
      return {
        paths,
        release() {
          for (const path of paths) files.delete(path);
          for (const [fd, handle] of handles) {
            if (handle.path.startsWith(root)) handles.delete(fd);
          }
        },
      };
    },
  };
})();
