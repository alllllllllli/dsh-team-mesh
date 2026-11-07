/**
 * refs.js — 证据引用（evidence_ref）的统一表示。
 *
 * 为什么需要这一层：原型里 evidence_ref 存的是**本机绝对路径**，比如 `F:\proof.txt`。
 * 一旦验收方在另一台机器上，那个路径根本不存在，门禁只能判"文件不存在 → 不可采信"，
 * 于是跨机永远无法完成任务。这不是配置问题，是表示层缺了一层。
 *
 * 两种引用：
 *   file  —— 本机文件。接受绝对路径、`file:///F:/...`、`file://F:/...` 三种写法。
 *   blob  —— 板服务上的内容寻址对象，形如 `blob://sha256:<64位hex>`。
 *            **哈希由板服务算**，客户端只上传字节，模型永远没有机会自报哈希。
 *
 * 判定"引用指向的东西到底在不在、内容对不对"是 store 的责任；这里只做纯解析。
 */

export const BLOB_SCHEME = 'blob://sha256:';

/** 形状像 URI 的前缀（`F:\x` 不会命中，因为盘符后面不是 `//`）。 */
const URI_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export function isBlobRef(ref) {
  return typeof ref === 'string' && ref.startsWith(BLOB_SCHEME);
}

export function blobRef(sha256) {
  return BLOB_SCHEME + String(sha256);
}

/** 从 blob 引用里取哈希；形状不对返回 null（不猜、不兜底）。 */
export function parseBlobRef(ref) {
  if (!isBlobRef(ref)) return null;
  const hex = ref.slice(BLOB_SCHEME.length).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function isUriLike(ref) {
  return typeof ref === 'string' && URI_LIKE.test(ref);
}

/**
 * 把 file 引用规整成可用的本机路径。
 *   `F:\a\b.txt`      → `F:\a\b.txt`
 *   `file:///F:/a.txt` → `F:/a.txt`
 *   `file://F:/a.txt`  → `F:/a.txt`
 * 非 file 引用原样返回（由调用方按 blob 分支处理）。
 */
export function toLocalPath(ref) {
  if (typeof ref !== 'string') return ref;
  const text = ref.trim();
  if (!/^file:\/\//i.test(text)) return text;
  let rest = text.replace(/^file:\/\//i, '');
  // `file:///F:/a` → `/F:/a`；Windows 下要砍掉那个多余的前导斜杠
  if (/^\/[A-Za-z]:[\\/]/.test(rest)) rest = rest.slice(1);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/**
 * 解析一条 evidence_ref 的形状。
 * @returns {{kind:'none'|'blob'|'file'|'unknown', localPath?:string, sha256?:string, raw:string}}
 */
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    return { kind: 'none', raw: '' };
  }
  const raw = ref.trim();
  if (isBlobRef(raw)) {
    const sha = parseBlobRef(raw);
    return sha === null ? { kind: 'unknown', raw } : { kind: 'blob', sha256: sha, raw };
  }
  if (isUriLike(raw) && !/^file:\/\//i.test(raw)) {
    // 认得出是 URI，但不是我们支持的两类：明确说"不支持"，不要当成路径去 stat
    return { kind: 'unknown', raw };
  }
  return { kind: 'file', localPath: toLocalPath(raw), raw };
}
