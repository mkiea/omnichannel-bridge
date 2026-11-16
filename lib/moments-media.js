/**
 * moments-media.js —— 说说用的两个「取图」动作（2026-11-16 从 `bridge.js` 抽出）
 *
 * 为什么先切这两块：说说子系统里**只有这两个是无状态的**（另三个：
 * `#publishMoment` 牵着 5 个登录态、`#noteMomentsUnsupported` 写跨模块锁存、
 * `#momentsLog` 只是 append 一行）。先切能切的，剩下的等前置做好。
 *
 * 端口（Ports & Adapters）：
 *   momentSticker({ config, faces }, name)              —— 从表情库取一张图（含三道闸）
 *   momentRecentPics({ imageDir, readFavorites }, n)    —— 从 qq-images 取最近 N 张
 *
 * ⚠️ `readFavorites` 由调用方注入，**不在这里读文件**：收藏表有 4 个读者
 * （图片清理的 `selectImagesToPrune`、说说、面板统计…），它不是说说私有的。
 * 把它搬进来说说模块，等于让其它三处去 import 说说 —— 依赖方向就反了。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 从**表情库**取一张图给说说用。
 *
 * 只认表情库，不认任意路径 —— 读任意本地文件再上传公网，是这条链路上唯一能造成
 * 真实泄露的动作。表情库里的文件本来就是我们自己收的。三道闸：能解析出图片项、
 * 扩展名在白名单里、大小不超过上限（默认 5 MB，base64 后会涨到约 6.7 MB）。
 *
 * @returns {{base64: string} | {error: string}}
 */
export function momentSticker(port, name) {
  const { faces, config = {} } = port
  const resolved = faces.resolve(String(name ?? ''))
  if (resolved === null) return { error: `表情库里没有「${name}」。可用：${faces.list().saved.map((s) => s.name).join('、') || '（空）'}` }
  const segment = resolved.segments?.[0]
  if (segment?.type !== 'image') return { error: `「${name}」是黄脸表情，说说只能配图片（收藏的图才行）` }
  const file = String(segment.data?.file ?? '')
  if (file === '' || !existsSync(file)) return { error: `表情文件不存在：${file || '(空)'}` }
  const ext = (file.match(/\.([a-zA-Z0-9]+)$/) ?? [])[1]?.toLowerCase() ?? ''
  if (!['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return { error: `不支持的图片类型：.${ext}` }
  const maxBytes = Number(config.momentImageMaxBytes) || 5 * 1024 * 1024
  const size = statSync(file).size
  if (size > maxBytes) return { error: `图片 ${(size / 1024 / 1024).toFixed(1)} MB，超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB` }
  return { base64: readFileSync(file).toString('base64') }
}

/**
 * 从 `qq-images` 取最近 N 张图（或标过喜欢的）。
 *
 * `n === -1` 是 `[pic:喜欢]`：**只取标过喜欢的**。为什么要有这一档：`[pic:N]` 按 mtime
 * 取"最近 N 张"会把表情包混进来（实测：最近 3 张里有一张 12KB 的表情包）。
 *
 * @returns {{images: string[], names: string[]} | {error: string}}
 */
export function momentRecentPics(port, n = 1) {
  const { imageDir, readFavorites = () => ({}) } = port
  try {
    const names = readdirSync(imageDir)
      .filter((name) => !name.startsWith('_') && /\.(jpe?g|png|gif|webp)$/i.test(name))
    if (names.length === 0) return { error: 'qq-images 里没有可用图片' }
    const favs = n === -1 ? readFavorites() : null
    if (n === -1 && Object.keys(favs).length === 0) {
      return { error: '还没标过喜欢的图（用 !fav 标一张，或改用 [pic:最近]）' }
    }
    const withTime = names
      .filter((name) => (n === -1 ? Object.hasOwn(favs, name) : true))
      .map((name) => {
        const full = join(imageDir, name)
        try {
          return { full, name, mtime: statSync(full).mtimeMs }
        } catch {
          return null
        }
      }).filter(Boolean).sort((a, b) => b.mtime - a.mtime)
    if (withTime.length === 0) return { error: '标记过的图已经不在 qq-images 里了' }
    const want = n === -1 ? Math.min(9, withTime.length) : Math.max(1, Math.min(9, Number(n) || 1))
    const picked = withTime.slice(0, want)
    if (picked.length === 0) return { error: '没取到图' }
    const out = []
    for (const item of picked) {
      const buf = readFileSync(item.full)
      if (buf.length > 10 * 1024 * 1024) continue   // 单张 ≤10MB（平台限制）
      out.push(buf.toString('base64'))
    }
    if (out.length === 0) return { error: '图片都超过了 10MB' }
    return { images: out, names: picked.slice(0, out.length).map((x) => x.name) }
  } catch (error) {
    return { error: `读图失败: ${error.message}` }
  }
}
