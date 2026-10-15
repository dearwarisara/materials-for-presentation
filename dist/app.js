const $ = (selector) => document.querySelector(selector);
const dropzone = $('#dropzone');
const input = $('#file-input');
const fileCard = $('#file-card');
const processButton = $('#process-button');
const statusPanel = $('#status-panel');
const errorMessage = $('#error-message');
const results = $('#results');
let selectedFile = null;

const formatBytes = (bytes) => { if (!bytes) return '0 KB'; const units = ['B','KB','MB','GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / Math.pow(1024, index)).toFixed(index ? 2 : 0)} ${units[index]}`; };
const baseName = (name) => name.replace(/\.pdf$/i, '');
const setError = (message) => { errorMessage.textContent = message; errorMessage.classList.remove('hidden'); };
const clearError = () => { errorMessage.textContent = ''; errorMessage.classList.add('hidden'); };

function setFile(file) {
  clearError();
  if (!file || file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { setError('กรุณาเลือกไฟล์ PDF เท่านั้น'); return; }
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
['dragenter','dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave','drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (event) => setFile(event.dataTransfer.files[0]));
$('#remove-file').addEventListener('click', resetAll);
$('#reset-button').addEventListener('click', resetAll);

function resetAll() {
  selectedFile = null; input.value = ''; fileCard.classList.add('hidden'); dropzone.classList.remove('hidden'); processButton.disabled = true; results.classList.add('hidden'); statusPanel.classList.add('hidden'); clearError(); window.scrollTo({ top: document.querySelector('.workspace').offsetTop - 30, behavior: 'smooth' });
}

function readUint32(view, offset) { return view.getUint32(offset, false); }
function readUint16(view, offset) { return view.getUint16(offset, false); }
function findJpeg(bytes, start) { for (let i = start; i < bytes.length - 1; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0xd8) return i; return -1; }
function findJpegEnd(bytes, start) { for (let i = start + 2; i < bytes.length - 1; i++) if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return i + 2; return -1; }

async function createCover(fileBuffer) {
  if (!window.pdfjsLib) throw new Error('PDF renderer is unavailable');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await window.pdfjsLib.getDocument({ data: fileBuffer }).promise;
  const page = await pdf.getPage(1); const viewport = page.getViewport({ scale: 1.5 });
  const maxWidth = 1000; const scale = Math.min(1, maxWidth / viewport.width); const scaled = page.getViewport({ scale: 1.5 * scale });
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(scaled.width); canvas.height = Math.ceil(scaled.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Cover export failed')), 'image/webp', .82));
}

async function stripMetadata(buffer) {
  if (!window.PDFLib) throw new Error('PDF metadata library is unavailable');
  const { PDFDocument, PDFName, PDFDict } = window.PDFLib;
  const pdfDoc = await PDFDocument.load(buffer, { updateMetadata: false, ignoreEncryption: false });
  const infoRef = pdfDoc.context.trailerInfo.Info;
  if (infoRef) {
    const info = pdfDoc.context.lookup(infoRef);
    if (info instanceof PDFDict) ['Title','Author','Subject','Keywords','Creator','Producer','CreationDate','ModDate'].forEach((key) => info.delete(PDFName.of(key)));
  }
  const rootRef = pdfDoc.context.trailerInfo.Root;
  if (rootRef) {
    const catalog = pdfDoc.context.lookup(rootRef);
    if (catalog && typeof catalog.delete === 'function') catalog.delete(PDFName.of('Metadata'));
  }
  const cleanedBytes = await pdfDoc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return new Blob([cleanedBytes], { type: 'application/pdf' });
}

processButton.addEventListener('click', async () => {
  if (!selectedFile) return; clearError(); processButton.disabled = true; statusPanel.classList.remove('hidden'); $('#status-title').textContent = 'กำลังประมวลผล…'; $('#status-detail').textContent = 'กำลังลบ metadata และเตรียม cover จากหน้าแรก';
  try {
    const buffer = await selectedFile.arrayBuffer(); await new Promise((resolve) => setTimeout(resolve, 450)); const cleanPdf = await stripMetadata(buffer); await new Promise((resolve) => setTimeout(resolve, 450)); const cover = await createCover(buffer);
    const stem = baseName(selectedFile.name); const pdfUrl = URL.createObjectURL(cleanPdf); const coverUrl = URL.createObjectURL(cover);
    $('#output-pdf-name').textContent = `${stem}_metadata-removed.pdf`; $('#pdf-result-meta').textContent = `${formatBytes(cleanPdf.size)} · ไฟล์ใหม่`; $('#pdf-download').href = pdfUrl; $('#pdf-download').download = `${stem}_metadata-removed.pdf`;
    $('#output-cover-name').textContent = `${stem}_page-1.webp`; $('#cover-result-meta').textContent = `${formatBytes(cover.size)} · หน้าแรก`; $('#cover-download').href = coverUrl; $('#cover-download').download = `${stem}_page-1.webp`; $('#cover-preview').src = coverUrl;
    statusPanel.classList.add('hidden'); results.classList.remove('hidden'); results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { statusPanel.classList.add('hidden'); processButton.disabled = false; setError('ไม่สามารถประมวลผลไฟล์นี้ได้ กรุณาลองเลือก PDF อื่น'); console.error(error); }
});
