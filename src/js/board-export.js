// Export chosen library boards without opening them or changing the active board.
import { exportable, safeName } from './export.js';
import { t } from './i18n.js';

let zipLibrary;
async function loadZip() {
  if (window.JSZip) return window.JSZip;
  if (!zipLibrary) zipLibrary = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/jszip.min.js', import.meta.url).href;
    script.onload = () => resolve(window.JSZip);
    script.onerror = () => { script.remove(); zipLibrary = null; reject(new Error(t('Could not load the ZIP exporter'))); };
    document.head.appendChild(script);
  });
  return zipLibrary;
}

export async function exportBoards(app, ids) {
  ids = [...new Set(ids)];
  if (!ids.length) return null;
  app.commitTextEdit();
  const files = [];
  const names = new Set();
  for (const id of ids) {
    const source = id === app.store.doc.id ? structuredClone(app.store.toJSON()) : await window.board.boards.load(id);
    if (!source) throw new Error(t('A selected board is no longer available. Refresh My boards and try again.'));
    const doc = await app.resolveAssets(source);
    if (doc.objects?.some((o) => o.type === 'image' && o.missing))
      throw new Error(t('“{name}” has missing images. Restore them before exporting.', { name: doc.name || t('Untitled board') }));
    const base = safeName(doc.name);
    let name = base + '.gazboard', suffix = 2;
    while (names.has(name.toLowerCase())) name = `${base} (${suffix++}).gazboard`;
    names.add(name.toLowerCase());
    files.push({ name, content: JSON.stringify(exportable(doc)) });
  }
  const multiple = files.length > 1;
  const path = await window.board.saveDialog({
    title: multiple ? t('Export {n} boards', { n: files.length }) : t('Export selected board'),
    defaultPath: multiple ? 'GazBoard-boards.zip' : files[0].name,
    filters: [{ name: multiple ? t('ZIP archive') : t('GazBoard file'), extensions: [multiple ? 'zip' : 'gazboard'] }]
  });
  if (!path) return null;
  let bytes;
  if (multiple) {
    const Zip = await loadZip();
    const zip = new Zip();
    for (const file of files) zip.file(file.name, file.content);
    bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 1 } });
  } else bytes = new TextEncoder().encode(files[0].content);
  await window.board.writeFile(path, bytes);
  app.toast(multiple ? t('Exported {n} boards', { n: files.length }) : t('Exported {n} board', { n: files.length }), 'check');
  return path;
}
