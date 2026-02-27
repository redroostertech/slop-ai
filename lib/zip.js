// JSZip is loaded as a global via <script> tag in sidepanel.html
export async function extractFromZip(file) {
  const zip = await JSZip.loadAsync(file);
  const files = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) {
      files[name] = entry;
    }
  }
  return { zip, files };
}

export async function readZipEntry(entry) {
  return await entry.async('string');
}
