import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer
} from './vendor/pdfjs/pdf.min.mjs'

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs')

const PDF_TO_CSS = 96 / 72
const PDF_FILE = /^https?:\/\/[^?#]*\.pdf(?:\?[^#]*)?(?:#.*)?$/i
const ARXIV_PDF = /^https:\/\/(?:www\.|export\.)?arxiv\.org\/pdf\/[^#]+(?:#.*)?$/i

const state = {
  pdf: null,
  pages: [],
  pdfUrl: '',
  fitWidth: true,
  zoom: 1,
  generation: 0,
  renderTasks: [],
  textLayers: [],
  checkedText: false,
  ignoreResizeUntil: 0
}

const textSelection = new Map()
let prevSelectionRange = null
let selectionListening = false

const viewer = document.getElementById('viewer')
const statusEl = document.getElementById('status')
const titleEl = document.getElementById('doc-title')
const pageLabel = document.getElementById('page-label')

const renderQueue = []
let renderPumpRunning = false

function extensionDir(path) {
  const url = chrome.runtime.getURL(path)
  return url.endsWith('/') ? url : url + '/'
}

function isPdfUrl(url) {
  return PDF_FILE.test(url || '') || ARXIV_PDF.test(url || '')
}

function readPdfUrl() {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : ''
  if (!raw) return ''
  let candidate = raw
  try {
    candidate = decodeURIComponent(raw)
  } catch {
    // 哈希里没有需要再解码的内容
  }
  const clean = candidate.split('#')[0]
  return isPdfUrl(clean) ? clean : ''
}

function labelFromPdfUrl(pdfUrl) {
  try {
    const url = new URL(pdfUrl)
    const arxiv = url.pathname.match(/\/pdf\/([^/]+)$/i)
    if (arxiv && /(^|\.)arxiv\.org$/i.test(url.hostname)) {
      return decodeURIComponent(arxiv[1].replace(/\.pdf$/i, ''))
    }
    const base = url.pathname.split('/').filter(Boolean).pop()
    return base ? decodeURIComponent(base) : url.hostname
  } catch {
    return 'PDF'
  }
}

function setStatus(message, isError) {
  statusEl.hidden = !message
  statusEl.textContent = message || ''
  statusEl.classList.toggle('error', Boolean(isError))
}

function scaleFor(page) {
  const base = page.getViewport({ scale: PDF_TO_CSS })
  if (!state.fitWidth) return state.zoom
  const width = Math.max(320, viewer.clientWidth - 32)
  return Math.min(2, Math.max(0.5, width / base.width))
}

function viewportFor(page) {
  return page.getViewport({ scale: scaleFor(page) * PDF_TO_CSS })
}

function updatePageLabel() {
  const pages = viewer.querySelectorAll('.pdf-page')
  if (!pages.length) {
    pageLabel.textContent = ''
    return
  }
  const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 2
  let current = 1
  pages.forEach((el) => {
    const rect = el.getBoundingClientRect()
    if (rect.top <= mid && rect.bottom >= mid) current = Number(el.dataset.page)
  })
  pageLabel.textContent = current + ' / ' + pages.length
}

function resetSelectionEnd(end, textLayer) {
  textLayer.append(end)
  end.style.width = ''
  end.style.height = ''
  textLayer.classList.remove('selecting')
}

function onSelectionChange() {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0) {
    textSelection.forEach(resetSelectionEnd)
    prevSelectionRange = null
    return
  }

  const active = new Set()
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i)
    textSelection.forEach((_end, textLayer) => {
      try {
        if (range.intersectsNode(textLayer)) active.add(textLayer)
      } catch {
        // 文字层已被替换
      }
    })
  }

  textSelection.forEach((end, textLayer) => {
    if (!textLayer.isConnected) {
      textSelection.delete(textLayer)
      return
    }
    if (active.has(textLayer)) textLayer.classList.add('selecting')
    else resetSelectionEnd(end, textLayer)
  })

  let range
  try {
    range = selection.getRangeAt(0)
  } catch {
    return
  }

  let modifyStart = false
  if (prevSelectionRange) {
    try {
      modifyStart = range.compareBoundaryPoints(Range.END_TO_END, prevSelectionRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, prevSelectionRange) === 0
    } catch {
      modifyStart = false
    }
  }
  let anchor = modifyStart ? range.startContainer : range.endContainer
  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode
  const parentTextLayer = anchor?.parentElement?.closest('.textLayer')
  const endDiv = parentTextLayer ? textSelection.get(parentTextLayer) : null
  if (endDiv && anchor.parentElement) {
    endDiv.style.width = parentTextLayer.style.width
    endDiv.style.height = parentTextLayer.style.height
    anchor.parentElement.insertBefore(endDiv, modifyStart ? anchor : anchor.nextSibling)
  }
  try {
    prevSelectionRange = range.cloneRange()
  } catch {
    prevSelectionRange = null
  }
}

function enableSelectionListener() {
  if (selectionListening) return
  selectionListening = true
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('pointerup', () => {
    textSelection.forEach(resetSelectionEnd)
    prevSelectionRange = null
  })
}

function registerTextLayer(div) {
  let end = div.querySelector('.endOfContent')
  if (!end) {
    end = document.createElement('div')
    end.className = 'endOfContent'
    div.append(end)
  }
  div.addEventListener('mousedown', () => {
    div.classList.add('selecting')
  })
  textSelection.set(div, end)
  enableSelectionListener()
}

async function ensurePage(pageNumber) {
  if (state.pages[pageNumber]) return state.pages[pageNumber]
  const page = await state.pdf.getPage(pageNumber)
  state.pages[pageNumber] = page
  return page
}

function applyPageBox(holder, viewport) {
  holder.style.width = Math.floor(viewport.width) + 'px'
  holder.style.height = Math.floor(viewport.height) + 'px'
  holder.style.setProperty('--scale-factor', String(viewport.scale))
}

async function renderPage(pageNumber) {
  const gen = state.generation
  const holder = viewer.querySelector('.pdf-page[data-page="' + pageNumber + '"]')
  if (!holder || holder.dataset.gen === String(gen)) return
  holder.dataset.gen = String(gen)

  let page
  try {
    page = await ensurePage(pageNumber)
  } catch (error) {
    holder.dataset.gen = ''
    console.error(error)
    return
  }
  if (gen !== state.generation) return

  const viewport = viewportFor(page)
  applyPageBox(holder, viewport)

  const canvas = holder.querySelector('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const previousLayer = holder.querySelector('.textLayer')
  if (textSelection.has(previousLayer)) textSelection.delete(previousLayer)
  const textLayerDiv = document.createElement('div')
  textLayerDiv.className = 'textLayer'
  textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale))
  previousLayer.replaceWith(textLayerDiv)

  const task = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport
  })
  task.promise.catch(() => {})
  state.renderTasks.push(task)

  const textLayer = new TextLayer({
    textContentSource: page.streamTextContent({
      includeMarkedContent: true,
      disableNormalization: true
    }),
    container: textLayerDiv,
    viewport
  })
  state.textLayers.push(textLayer)

  try {
    await Promise.all([task.promise, textLayer.render()])
    if (gen !== state.generation || !textLayerDiv.isConnected) return
    if (pageNumber === 1 && !state.checkedText) {
      state.checkedText = true
      const text = textLayer.textContentItemsStr.join('')
      if (!text.trim()) {
        setStatus('这份 PDF 没有可选中的文字层，无法划词。它可能是扫描件。', true)
      }
    }
    registerTextLayer(textLayerDiv)
  } catch (error) {
    if (gen !== state.generation || error?.name === 'RenderingCancelledException') return
    holder.dataset.gen = ''
    console.error('PDF page render failed:', error)
  }
}

function enqueueRender(pageNumber) {
  if (!renderQueue.includes(pageNumber)) renderQueue.push(pageNumber)
  pumpRenderQueue()
}

async function pumpRenderQueue() {
  if (renderPumpRunning) return
  renderPumpRunning = true
  try {
    while (renderQueue.length) {
      const next = renderQueue.shift()
      await renderPage(next)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  } finally {
    renderPumpRunning = false
    if (renderQueue.length) pumpRenderQueue()
  }
}

function renderVisiblePages() {
  const root = viewer.getBoundingClientRect()
  const wanted = []
  viewer.querySelectorAll('.pdf-page').forEach((el) => {
    const rect = el.getBoundingClientRect()
    if (rect.bottom >= root.top - 80 && rect.top <= root.bottom + 240) {
      if (el.dataset.gen === String(state.generation)) return
      wanted.push(Number(el.dataset.page))
    }
  })
  wanted.sort((a, b) => a - b)
  wanted.forEach(enqueueRender)
}

function cancelRenders() {
  state.renderTasks.forEach((task) => {
    try {
      task.cancel()
    } catch {
      // 这一页已经画完
    }
  })
  state.textLayers.forEach((layer) => {
    try {
      layer.cancel()
    } catch {
      // 文字层已经结束
    }
  })
  state.renderTasks = []
  state.textLayers = []
  renderQueue.length = 0
}

function relayout() {
  cancelRenders()
  state.generation += 1
  textSelection.clear()
  prevSelectionRange = null
  const sample = state.pages.find(Boolean)
  state.pages.forEach((page, index) => {
    const holder = viewer.querySelector('.pdf-page[data-page="' + index + '"]')
    if (!holder) return
    holder.dataset.gen = ''
    const viewport = viewportFor(page || sample)
    applyPageBox(holder, viewport)
  })
  renderVisiblePages()
  updatePageLabel()
}

function createPlaceholders(pageCount, samplePage) {
  const sampleViewport = viewportFor(samplePage)
  const fragment = document.createDocumentFragment()
  for (let i = 1; i <= pageCount; i += 1) {
    const holder = document.createElement('div')
    holder.className = 'pdf-page'
    holder.dataset.page = String(i)
    applyPageBox(holder, sampleViewport)
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(sampleViewport.width)
    canvas.height = Math.floor(sampleViewport.height)
    holder.appendChild(canvas)
    const textLayer = document.createElement('div')
    textLayer.className = 'textLayer'
    holder.appendChild(textLayer)
    fragment.appendChild(holder)
  }
  viewer.replaceChildren(fragment)
}

function resizeCanvas(holder, viewport) {
  const canvas = holder.querySelector('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
}

async function openPdf(pdfUrl) {
  state.pdfUrl = pdfUrl
  const label = labelFromPdfUrl(pdfUrl)
  titleEl.textContent = label
  document.title = label + ' - QuickTranslate'
  setStatus('正在打开第 1 页…')

  const pdf = await getDocument({
    url: pdfUrl,
    cMapUrl: extensionDir('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: extensionDir('vendor/pdfjs/standard_fonts/'),
    disableAutoFetch: true,
    isEvalSupported: false
  }).promise

  state.pdf = pdf
  state.pages = []
  const firstPage = await pdf.getPage(1)
  state.pages[1] = firstPage
  createPlaceholders(pdf.numPages, firstPage)
  const firstHolder = viewer.querySelector('.pdf-page[data-page="1"]')
  resizeCanvas(firstHolder, viewportFor(firstPage))
  setStatus('')
  updatePageLabel()
  state.ignoreResizeUntil = Date.now() + 600
  enqueueRender(1)

  pdf.getMetadata().then((meta) => {
    const title = meta?.info?.Title
    if (title) {
      titleEl.textContent = title
      document.title = title + ' - QuickTranslate'
    }
  }).catch(() => {})
}

function currentZoom() {
  const page = state.pages[1]
  return page ? scaleFor(page) : state.zoom
}

document.getElementById('zoom-in').addEventListener('click', () => {
  state.fitWidth = false
  state.zoom = Math.min(3, currentZoom() * 1.15)
  relayout()
})

document.getElementById('zoom-out').addEventListener('click', () => {
  state.fitWidth = false
  state.zoom = Math.max(0.4, currentZoom() / 1.15)
  relayout()
})

document.getElementById('fit-width').addEventListener('click', () => {
  state.fitWidth = true
  relayout()
})

document.getElementById('open-native').addEventListener('click', () => {
  if (!state.pdfUrl) return
  chrome.runtime.sendMessage({ action: 'openPdfNative', url: state.pdfUrl })
})

let scrollScheduled = false
viewer.addEventListener('scroll', () => {
  if (scrollScheduled) return
  scrollScheduled = true
  requestAnimationFrame(() => {
    scrollScheduled = false
    updatePageLabel()
    renderVisiblePages()
  })
}, { passive: true })

let resizeTimer = 0
let lastViewerWidth = viewer.clientWidth
new ResizeObserver(() => {
  if (!state.fitWidth || !state.pdf || Date.now() < state.ignoreResizeUntil) return
  const width = viewer.clientWidth
  if (Math.abs(width - lastViewerWidth) < 8) return
  lastViewerWidth = width
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(relayout, 200)
}).observe(viewer)

chrome.runtime.sendMessage({ action: 'pdfViewerReady' })

const pdfUrl = readPdfUrl()
if (!pdfUrl) {
  setStatus('没有找到 PDF 地址。请打开以 .pdf 结尾的链接，或 arXiv 论文。', true)
} else {
  openPdf(pdfUrl).catch((error) => {
    console.error(error)
    setStatus(error.message || 'PDF 打开失败', true)
  })
}
