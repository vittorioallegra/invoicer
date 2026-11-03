export interface PdfPreview {
  /** Object URL of the rendered PDF; the caller revokes it when it is no longer needed. */
  url: string;
  /** False when no tab could be opened and the file was downloaded instead. */
  opened: boolean;
}

/**
 * Shows a PDF rendered in the browser. The tab is opened synchronously, inside the click that
 * called this (a window opened after the async render is treated as a popup and blocked), and
 * pointed at the PDF once it exists. When the browser refuses the tab, the file is downloaded
 * instead, which is not subject to the page's `object-src 'none'` CSP.
 */
export async function previewPdf(render: () => Promise<Uint8Array>, fileName: string) {
  const tab = window.open("", "_blank");
  try {
    const bytes = await render();
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    if (tab && !tab.closed) {
      tab.location.href = url;
      return { url, opened: true } satisfies PdfPreview;
    }
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    return { url, opened: false } satisfies PdfPreview;
  } catch (error) {
    tab?.close();
    throw error;
  }
}
