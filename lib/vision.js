/**
 * vision.js —— 把本地媒体变成「模型能看的东西」（2026-11-16 从 `bridge.js` 抽出）
 *
 * 这一簇原来散在 bridge 里的五个私有方法：`#gifVision` / `#gifMeta` / `#gifSheet` /
 * `#imageBlocksFor` / `#shrinkForVision`，合计 216 行、**只依赖 config / imageDir /
 * 附件服务 / 日志**。它是"以后加新模态"的落点：改"图片怎么给模型看"只该改这一处，
 * 而不是在 1.4 万行里找五个方法。
 *
 * 端口（Ports & Adapters）：
 *   {
 *     config,        // ffmpegPath / gifFrameExtract
 *     imageDir,      // 临时帧与缩图的落地目录
 *     attachments,   // 宿主的附件服务（只需 { saveImages(refs) }）；没有就退化成"不附图"
 *     debugLog,      // 注入而不是 import：日志落盘路径由宿主决定
 *   }
 *
 * 本文件不 import bridge（`module-gate` 的 `deps:branch-to-trunk` 看守）。
 * 逻辑逐字搬迁，没有顺手改行为 —— 迁移动机是结构，不是修 bug。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { extractGifFrames } from './gif-frames.js'

/**
 * GIF 三帧拼图：整包按 `image/gif` 挂上去，解码侧只解**第一帧** ——
 * 第一帧是黑屏/标题的动图 ⇒ 她什么都看不见；动作变化 ⇒ 全丢。
 * 所以先抽三帧横拼成一张，再把这张当图挂上去。
 *
 * @returns {Promise<{vision: string, note: string}>} 替换后的路径与给模型看的说明
 */
export async function gifVision(port, file) {
  const path = String(file ?? '')
  if (!/\.gif$/i.test(path)) return { vision: file, note: '' }
  const meta = await gifMeta(port, path)
  const sheet = await gifSheet(port, path, meta)
  return sheet ? { vision: sheet.path, note: sheet.note } : { vision: file, note: '' }
}

/** 抽帧 → 横拼。任一步失败就退回"只取首帧"的老行为（至少不会比现在更差）。 */
function gifSheet(port, file, meta) {
  const debugLog = port.debugLog ?? (() => {})
  const config = port.config ?? {}
  return new Promise((resolve) => {
    if (!config.gifFrameExtract) { resolve(null); return }
    if (!String(file).toLowerCase().endsWith('.gif')) { resolve(null); return }
    const base = String(file).replace(/\.gif$/i, '')
    const sheet = `${base}-sheet.png`
    if (existsSync(sheet)) { resolve({ path: sheet, note: '' }); return }
    const ffmpeg = config.ffmpegPath || 'ffmpeg'
    const info = meta ?? {}
    const frames = Math.max(1, Math.round((Number(info.fps) || 10) * (Number(info.durationSec) || 1)))
    // 跳过首帧（常是空白）：25% / 55% / 85%，去重后不重复
    const picks = [...new Set([
      Math.max(1, Math.round(frames * 0.25)),
      Math.round(frames * 0.55),
      Math.max(1, Math.min(frames - 1, Math.round(frames * 0.85))),
    ])].filter((n) => n >= 0 && n < Math.max(1, frames)).sort((a, b) => a - b)
    const extract = (indices) => new Promise((done) => {
      const select = indices.map((n) => `eq(n\\,${n})`).join('+')
      const pattern = `${base}-f%d.png`
      // 单帧宽上限 400：三帧横拼后约 1200 宽，仍在多模态的常规缩放区间内；
      // 不设上限的话，一张 1080 宽的 GIF 拼完是 3240 宽，会被整体缩小、每帧糊掉。
      execFile(ffmpeg, ['-y', '-i', file, '-vf', `select='${select}',scale='min(400,iw)':-1`, '-vsync', '0', pattern], { timeout: 25_000 }, (error) => {
        if (error) { debugLog(`gif frame extract failed: ${error.message}`); done([]); return }
        const files = indices.map((_, i) => `${base}-f${i + 1}.png`).filter((p) => existsSync(p))
        done(files)
      })
    })
    const cleanup = (files) => { for (const f of files) { try { unlinkSync(f) } catch { /* best effort */ } } }
    const fallback = () => {
      // 老行为：只取首帧（至少不会比现在更差）
      const out = `${base}-frame.png`
      if (existsSync(out)) { resolve({ path: out, note: '' }); return }
      execFile(ffmpeg, ['-y', '-i', file, '-frames:v', '1', out], { timeout: 20_000 }, (error) => {
        resolve(error ? null : (existsSync(out) ? { path: out, note: '' } : null))
      })
    }
    extract(picks.length >= 2 ? picks : [0]).then((files) => {
      if (files.length === 0) { fallback(); return }
      if (files.length === 1) { cleanup(files.slice(1)); resolve({ path: files[0], note: `（这是动图，共约 ${frames} 帧；这张是其中一帧）` }); return }
      const args = []
      for (const f of files) args.push('-i', f)
      args.push('-filter_complex', `hstack=inputs=${files.length}`, '-frames:v', '1', '-y', sheet)
      execFile(ffmpeg, args, { timeout: 25_000 }, (error) => {
        cleanup(files)
        if (error || !existsSync(sheet)) { fallback(); return }
        resolve({ path: sheet, note: `（这是动图，共约 ${frames} 帧；上面这张图从左到右是其中 ${files.length} 帧，按时间顺序）` })
      })
    })
  })
}

/**
 * 读 GIF 的时长与帧率 —— 本机没有 ffprobe（只有 ffmpeg），所以从 `-i` 的 stderr 里抠。
 * 抠不到就返回 `{}`，调用方按默认值（10fps / 1 秒）兜底，不会因此失败。
 */
function gifMeta(port, file) {
  const config = port.config ?? {}
  return new Promise((resolve) => {
    execFile(config.ffmpegPath || 'ffmpeg', ['-i', file], { timeout: 10_000 }, (_error, _stdout, stderr) => {
      const text = String(stderr || '')
      const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
      const fps = /(\d+(?:\.\d+)?)\s*fps/.exec(text)
      if (!dur) { resolve({}); return }
      const durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
      resolve({ durationSec: Number.isFinite(durationSec) ? durationSec : 1, fps: fps ? Number(fps[1]) : 10 })
    })
  })
}

/**
 * 把过大的图缩到长边 ≤1600 供原生附图（2026-11-03）。
 * 用 ffmpeg（GIF 抽帧已经在用它，不引新依赖）；输出 png 保透明；失败返回空串。
 */
export function shrinkForVision(port, file) {
  const debugLog = port.debugLog ?? (() => {})
  const config = port.config ?? {}
  return new Promise((resolve) => {
    const out = String(file).replace(/\.[^.]+$/, '') + '-small.png'
    if (existsSync(out)) { resolve(out); return }
    const filter = "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease"
    execFile(config.ffmpegPath || 'ffmpeg', ['-y', '-i', file, '-vf', filter, '-frames:v', '1', out],
      { timeout: 30_000 },
      (error) => {
        if (error) { debugLog(`image shrink failed: ${error.message}`); resolve(''); return }
        resolve(existsSync(out) ? out : '')
      })
  })
}

/**
 * 附本地图片为原生多模态块（DSH attachment seam）。
 *
 * @param {{config: object, imageDir: string, attachments: object|null, debugLog?: Function}} port
 * @param {string[]} files
 * @param {number} [limit] 本次最多挂几张（视频自适应帧数会传 >4）
 * @returns {Promise<Array<{type: 'image', attachment: object}>>}
 */
export async function imageBlocksFor(port, files, limit = 4) {
  const { imageDir, attachments } = port
  const config = port.config ?? {}
  const debugLog = port.debugLog ?? (() => {})
  if (files.length === 0) return []
  if (!attachments || typeof attachments.saveImages !== 'function') {
    debugLog('native vision unavailable: attachments service not mounted')
    return []
  }
  // 上限由调用方给（视频自适应帧数要走 4 张以上）；其它调用点不传，保持老行为
  const maxAttach = Math.max(1, Math.min(12, Number(limit) || 4))

  /**
   * ① 去重（2026-11-03，主人要求）。
   *
   * 同一张图会从多条路径进来：主消息、引用、转发节点、视频帧、甚至同一张图在群里被转两次。
   * 之前不去重 ⇒ 同一张图重复附图、重复占预算（4 张 budget 里 2 张是同一张），
   * 而且模型会以为"他发了两次"。
   *
   * 按**内容哈希**而不是 URL：CDN url 带 rkey（每次都变），代理 url 带时间戳，都不稳定。
   */
  const expanded = []
  const tempFrames = []
  for (const file of files) {
    if (/\.gif$/i.test(file)) {
      const frames = await extractGifFrames({
        file,
        outDir: join(imageDir, '_gif-frames'),
        ffmpegPath: config.ffmpegPath || 'ffmpeg',
        want: Math.max(2, Math.min(4, maxAttach)),
      })
      if (frames.length >= 2) {
        debugLog(`gif frames: ${basename(file)} → ${frames.length} 帧`)
        expanded.push(...frames)
        tempFrames.push(...frames)
        continue
      }
    }
    expanded.push(file)
  }

  const seen = new Set()
  const picked = []
  for (const file of expanded) {
    let hash = String(file)
    try { hash = createHash('sha256').update(readFileSync(file)).digest('hex') } catch { /* 读不到就按路径当键 */ }
    if (seen.has(hash)) { debugLog(`image dedup: ${basename(file)}`); continue }
    seen.add(hash)
    picked.push(file)
    if (picked.length >= maxAttach) break
  }

  const build = (file) => {
    const buffer = readFileSync(file)
    const lower = file.toLowerCase()
    const mediaType = lower.endsWith('.png') ? 'image/png'
      : lower.endsWith('.gif') ? 'image/gif'
      : lower.endsWith('.webp') ? 'image/webp'
      : 'image/jpeg'
    // SaveImageAttachment.data 的类型是 Uint8Array（sharp 直接把 Buffer 当字节解码）。
    // 旧代码传 base64 字符串，sharp 会把它当**文件路径**去 open ⇒ ENOENT ⇒ 被包成
    // INVALID_IMAGE「Unsupported or malformed image data.」⇒ native 附图 100% 失败。
    return { data: new Uint8Array(buffer), mediaType, name: basename(file) }
  }

  /**
   * ② 逐张挂载 + 超像素上限时**先缩小再挂**（2026-11-03）。
   *
   * 真机：`native image attach failed: Image exceeds the configured per-side pixel limit.`
   * —— 一张 5366×9200 的长截图，图**下载成功**但挂不上去，用户看到的就是
   * "下载了但是没法过来"。宿主的上限在附件服务里（不在我们这），所以按报错驱动重试：
   * 缩到长边 1600 再挂一次。逐张而不是批量：一张失败不连累同批其它图。
   */
  const out = []
  let failed = 0
  for (const file of picked) {
    try {
      const refs = await attachments.saveImages([build(file)])
      out.push(...refs.map((attachment) => ({ type: 'image', attachment })))
      continue
    } catch (error) {
      const msg = String(error?.message ?? error)
      if (/pixel limit|too large|dimensions|INVALID_IMAGE/i.test(msg)) {
        try {
          const small = await shrinkForVision(port, file)
          if (small !== '') {
            const refs = await attachments.saveImages([build(small)])
            out.push(...refs.map((attachment) => ({ type: 'image', attachment })))
            debugLog(`image shrunk for vision: ${basename(file)}`)
            continue
          }
        } catch (retryError) {
          debugLog(`image shrink retry failed: ${retryError.message}`)
        }
      }
      failed += 1
      debugLog(`native image attach failed: ${msg}`)
    }
  }
  if (failed > 0) debugLog(`native image attach: ${failed}/${picked.length} 张没挂上`)
  // 临时帧附完就删（附件服务已经把字节复制走了，路径留着只会变成垃圾）
  for (const frame of tempFrames) {
    try { unlinkSync(frame) } catch { /* 删不掉就算了，下次启动的清理会扫到 */ }
  }
  return out
}
