const $ = (selector) => document.querySelector(selector);
const dropzone = $('#dropzone');
const input = $('#file-input');
const fileCard = $('#file-card');
const processButton = $('#process-button');
const statusPanel = $('#status-panel');
const errorMessage = $('#error-message');
const results = $('#results');
const metadataKeys = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];
let selectedFile = null;
let outputUrls = [];

const formatBytes = (bytes) => { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / Math.pow(1024, index)).toFixed(index ? 2 : 0)} ${units[index]}`; };
const baseName = (name) => name.replace(/\.pdf$/i, '');
const setError = (message) => { errorMessage.textContent = message; errorMessage.classList.remove('hidden'); };
const clearError = () => { errorMessage.textContent = ''; errorMessage.classList.add('hidden'); };
const setStatus = (title, detail) => { $('#status-title').textContent = title; $('#status-detail').textContent = detail; };

function setFile(file) {
  clearError();
  if (!file || (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))) { setError('กรุณาเลือกไฟล์ PDF เท่านั้น'); return; }
  selectedFile = file;
  $('#file-name').textContent = file.name;
  $('#file-size').textContent = formatBytes(file.size);
  fileCard.classList.remove('hidden');
  processButton.disabled = false;
  dropzone.classList.add('hidden');
  results.classList.add('hidden');
}

dropzone.addEventListener('click', () => input.click());
dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
input.addEventListener('change', (event) => setFile(event.target.files[0]));
['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (event) => setFile(event.dataTransfer.files[0]));
$('#remove-file').addEventListener('click', resetAll);
$('#reset-button').addEventListener('click', resetAll);

function resetAll() {
  outputUrls.forEach((url) => URL.revokeObjectURL(url));
  outputUrls = [];
  selectedFile = null;
  input.value = '';
  fileCard.classList.add('hidden');
  dropzone.classList.remove('hidden');
  processButton.disabled = true;
  results.classList.add('hidden');
  statusPanel.classList.add('hidden');
  clearError();
  window.scrollTo({ top: document.querySelector('.workspace').offsetTop - 30, behavior: 'smooth' });
}

function configurePdfJs() {
  if (!window.pdfjsLib) throw new Error('PDF renderer is unavailable');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

async function openPdf(data) {
  configurePdfJs();
  return window.pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;
}

async function renderPage(data, pageNumber = 1, targetMax = 1400) {
  const pdf = await openPdf(data);
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.5, targetMax / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale: Math.max(0.2, scale) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
  return canvas;
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('WebP export failed')), 'image/webp', quality));
}

async function createCover(fileBuffer, maxKB) {
  let canvas = await renderPage(fileBuffer, 1, 1400);
  let quality = 0.82;
  const maxBytes = maxKB * 1024;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const blob = await canvasToBlob(canvas, quality);
    if (blob.size <= maxBytes || (canvas.width <= 180 && canvas.height <= 180)) return blob;
    if (quality > 0.42) quality = Math.max(0.38, quality - 0.1);
    else canvas = await renderPage(fileBuffer, 1, Math.max(180, Math.round(Math.max(canvas.width, canvas.height) * 0.78)));
  }
  return canvasToBlob(canvas, 0.34);
}

async function stripMetadata(buffer) {
  if (!window.PDFLib) throw new Error('PDF metadata library is unavailable');
  const { PDFDocument, PDFName, PDFDict } = window.PDFLib;
  const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: false });
  const infoRef = pdfDoc.context.trailerInfo.Info;
  if (infoRef) {
    const info = pdfDoc.context.lookup(infoRef);
    if (info instanceof PDFDict) metadataKeys.forEach((key) => info.delete(PDFName.of(key)));
  }
  const rootRef = pdfDoc.context.trailerInfo.Root;
  if (rootRef) {
    const catalog = pdfDoc.context.lookup(rootRef);
    if (catalog && typeof catalog.delete === 'function') catalog.delete(PDFName.of('Metadata'));
  }
  return pdfDoc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

async function readVerification(originalBytes, cleanedBytes, coverBlob) {
  const originalPdf = await openPdf(originalBytes);
  const cleanedPdf = await openPdf(cleanedBytes);
  const pagesMatch = originalPdf.numPages === cleanedPdf.numPages;
  const [originalCanvas, cleanedCanvas] = await Promise.all([renderPage(originalBytes, 1, 1100), renderPage(cleanedBytes, 1, 1100)]);
  let differentPixels = 0;
  let renderMatch = originalCanvas.width === cleanedCanvas.width && originalCanvas.height === cleanedCanvas.height;
  if (renderMatch) {
    const originalPixels = originalCanvas.getContext('2d').getImageData(0, 0, originalCanvas.width, originalCanvas.height).data;
    const cleanedPixels = cleanedCanvas.getContext('2d').getImageData(0, 0, cleanedCanvas.width, cleanedCanvas.height).data;
    for (let index = 0; index < originalPixels.length; index += 4) {
      if (Math.abs(originalPixels[index] - cleanedPixels[index]) > 6 || Math.abs(originalPixels[index + 1] - cleanedPixels[index + 1]) > 6 || Math.abs(originalPixels[index + 2] - cleanedPixels[index + 2]) > 6) differentPixels += 1;
    }
    renderMatch = differentPixels / (originalCanvas.width * originalCanvas.height) <= 0.001;
  }
  const metadata = await cleanedPdf.getMetadata().catch(() => ({ info: {}, metadata: null }));
  const remainingInfo = metadataKeys.filter((key) => metadata.info && metadata.info[key] !== undefined && metadata.info[key] !== null && String(metadata.info[key]).trim() !== '');
  const metadataCleared = remainingInfo.length === 0 && !metadata.metadata;
  return { pagesMatch, renderMatch, metadataCleared, coverWithinLimit: Boolean(coverBlob), differentPixels };
}

function updateCheck(id, passed) {
  const item = $(`#${id}`);
  item.classList.toggle('check-pass', passed);
  item.classList.toggle('check-fail', !passed);
  item.querySelector('.check-mark').textContent = passed ? '✓' : '!';
}

processButton.addEventListener('click', async () => {
  if (!selectedFile) return;
  clearError();
  processButton.disabled = true;
  statusPanel.classList.remove('hidden');
  setStatus('กำลังอ่านไฟล์…', 'ตรวจสอบโครงสร้าง PDF และจำนวนหน้า');
  try {
    const buffer = await selectedFile.arrayBuffer();
    const maxKB = 500;
    setStatus('กำลังลบ metadata…', 'สร้าง PDF ใหม่โดยไม่บีบอัดและไม่เปลี่ยนหน้าเอกสาร');
    const cleanedBytes = await stripMetadata(buffer);
    setStatus('กำลังสร้าง cover…', `เรนเดอร์หน้าแรกเป็น WebP ไม่เกิน ${maxKB} KB`);
    const cover = await createCover(buffer, maxKB);
    setStatus('กำลังตรวจสอบผลลัพธ์…', 'เปรียบเทียบจำนวนหน้า metadata และการเรนเดอร์หน้าแรก');
    const verification = await readVerification(buffer, cleanedBytes, cover);
    const allPassed = verification.pagesMatch && verification.renderMatch && verification.metadataCleared && verification.coverWithinLimit && cover.size <= maxKB * 1024;
    const pdfBlob = new Blob([cleanedBytes], { type: 'application/pdf' });
    const pdfUrl = URL.createObjectURL(pdfBlob);
    const coverUrl = URL.createObjectURL(cover);
    outputUrls = [pdfUrl, coverUrl];
    const stem = baseName(selectedFile.name);
    $('#output-pdf-name').textContent = `${stem}_metadata-removed.pdf`;
    $('#pdf-result-meta').textContent = `${formatBytes(pdfBlob.size)} · ไฟล์ใหม่ · ไม่บีบอัด`;
    $('#pdf-download').href = pdfUrl;
    $('#pdf-download').download = `${stem}_metadata-removed.pdf`;
    $('#output-cover-name').textContent = `${stem}_page-1.webp`;
    $('#cover-result-meta').textContent = `${formatBytes(cover.size)} · หน้าแรก · สูงสุด ${formatBytes(maxKB * 1024)}`;
    $('#cover-download').href = coverUrl;
    $('#cover-download').download = `${stem}_page-1.webp`;
    $('#cover-preview').src = coverUrl;
    updateCheck('check-pages', verification.pagesMatch);
    updateCheck('check-metadata', verification.metadataCleared);
    updateCheck('check-render', verification.renderMatch);
    updateCheck('check-cover', verification.coverWithinLimit && cover.size <= maxKB * 1024);
    $('#verification-summary').textContent = allPassed ? 'ผ่าน 4/4 รายการ' : 'มีรายการที่ต้องตรวจซ้ำ';
    $('#overall-badge').textContent = allPassed ? '✓ ตรวจสอบแล้ว' : '! ตรวจสอบซ้ำ';
    $('#overall-badge').classList.toggle('warning-badge', !allPassed);
    statusPanel.classList.add('hidden');
    results.classList.remove('hidden');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    statusPanel.classList.add('hidden');
    processButton.disabled = false;
    setError('ไม่สามารถประมวลผลไฟล์นี้ได้ กรุณาลองเลือก PDF อื่น');
    console.error(error);
  }
});
