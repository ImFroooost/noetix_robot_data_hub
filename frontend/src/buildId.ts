/** 从已加载的主 bundle 文件名里读构建号，用于确认浏览器跑的是哪一版。 */
export const BUILD_ID = (() => {
  try {
    const scripts = Array.from(document.scripts);
    const src = scripts
      .map((s) => (s as HTMLScriptElement).src || "")
      .find((s) => /\/assets\/index-[^/]+\.js/.test(s));
    return src?.match(/index-([^.]+)\.js/)?.[1] || "dev";
  } catch {
    return "dev";
  }
})();
