/**
 * download.js —— 唯一的「URL → 本地文件」入口（2026-11-15 从 `bridge.js` 抽出）
 *
 * 为什么它必须先出来：`forward-expand.js` 要下载转发节点里的图片，而它**不许 import bridge**
 * （闸门 `deps:branch-to-trunk` 会拦）。所以这个被 6 处共用的下载函数必须先成为独立模块，
 * 否则每迁一个模块都要重新发明一遍下载，或者在端口里塞一堆回调。
 *
 * ★ 历史教训（原注释保留，不要删）：2026-10-31 红队 K②/K⑤ 之前，这里**自己写了一遍**
 * `assertEgress` + 裸 `fetch` + `arrayBuffer()`。问题不在写错，而在它是第 **4** 条独立的
 * 下载路径 —— 当天早些时候把入站媒体 / get_file 回退 / 群文件三处收进 `fetchGuarded` 时
 * 漏的就是它，而它被 6 个调用点共用（关键词配图、OCR、引用图、转发图、头像…）。
 * 同一个策略只盖住部分入口，缺失的地方不报错 —— 这次是「302 跳到内网仍被真实请求」
 * 和「无大小上限」两个后果一起暴露。
 *
 * ⇒ **本文件是唯一下载入口**。新增下载需求请调用 `downloadTo`，不要另起 fetch。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fetchGuarded } from './egress.js'

/** 单张附件上限（16 MiB）。走 `fetchGuarded` 的流式限流，超了直接断，不会先下满再砍。 */
export const DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024

/** 按 Content-Type 猜扩展名；猜不出就按 URL 的扩展名，再不行 `.png`。 */
export function guessImageExt(contentType, url) {
  if (typeof contentType === 'string') {
    if (contentType.includes('gif')) return '.gif'
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg'
    if (contentType.includes('webp')) return '.webp'
    if (contentType.includes('png')) return '.png'
  }
  const ext = extname(String(url).split('?')[0])
  return ext || '.png'
}

/**
 * 把 URL 下到 `directory/name<ext>`，返回落地路径。
 *
 * 失败一律抛 `download <原因>`：保留这个前缀是有用的 —— 2026-10-30 真机排查就靠它在
 * trace 里认出「这是图片下载失败」。`fetchGuarded` 抛的错误里带着服务端理由
 * （`HTTP 400（invalid rkey -5503010）`），上层的「这张图废了，去 get_image/本地缓存另找
 * 一条路」正是靠 `invalid rkey` 触发的。
 */
export async function downloadTo(url, directory, name) {
  try {
    const { buffer, contentType } = await fetchGuarded(url, {
      maxBytes: DOWNLOAD_MAX_BYTES,
      timeoutMs: 30_000,
    })
    if (buffer.length === 0) throw new Error('download empty')
    mkdirSync(directory, { recursive: true })
    const ext = guessImageExt(contentType, url)
    const filePath = join(directory, `${name}${ext}`)
    writeFileSync(filePath, buffer)
    return filePath
  } catch (error) {
    throw new Error(`download ${error.message}`)
  }
}
