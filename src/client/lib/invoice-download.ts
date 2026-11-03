/** Downloads a file the Worker serves as an attachment. */
export function downloadUrl(href: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}
