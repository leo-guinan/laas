(() => {
  const cfg = window.LAAS_CONFIG || {};
  const bookingUrl = cfg.bookingUrl || "#";

  const sourceParams = new URLSearchParams(window.location.search);

  function withParams(url) {
    if (!url || url === "#") return "#";
    try {
      const target = new URL(url);
      for (const [key, value] of sourceParams.entries()) {
        if (!target.searchParams.has(key)) target.searchParams.set(key, value);
      }
      return target.toString();
    } catch {
      return url;
    }
  }

  document.querySelectorAll("[data-cta]").forEach((el) => {
    el.href = withParams(bookingUrl);
  });
})();
