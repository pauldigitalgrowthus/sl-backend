const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

pdfjsLib.GlobalWorkerOptions.workerSrc = null;

async function extractTOCFromPDF(url) {
  try {
    const loadingTask = pdfjsLib.getDocument({
      url,
      useSystemFonts: true,
    });

    const pdf = await loadingTask.promise;

    const outline = await pdf.getOutline();
    if (!outline) return [];

    const toc = [];

    async function parse(items, depth = 0) {
      for (const item of items) {
        let pageIndex = null;

        if (item.dest) {
          try {
            // dest can be a string (named dest) or an array
            const dest =
              typeof item.dest === "string"
                ? await pdf.getDestination(item.dest)
                : item.dest;

            if (dest && dest[0]) {
              pageIndex = await pdf.getPageIndex(dest[0]);
            }
          } catch (err) {
            console.log("TOC parse error:", err.message);
          }
        }

        toc.push({
          title: item.title,
          pageIndex,
          depth,
        });

        if (item.items && item.items.length > 0) {
          await parse(item.items, depth + 1);
        }
      }
    }

    await parse(outline);

    return toc;
  } catch (error) {
    console.error("PDF TOC Extraction Error:", error.message);
    return [];
  }
}

module.exports = {
  extractTOCFromPDF,
};