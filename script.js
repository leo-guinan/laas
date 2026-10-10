(() => {
  const cfg = window.LAAS_CONFIG || {};
  const bookingUrl = cfg.bookingUrl || "#";
  const experiment = "laas_three_way_v1";
  const variant = "sales";

  const sourceParams = new URLSearchParams(window.location.search);

  function withParams(url) {
    if (!url || url === "#") return "#";
    try {
      const target = new URL(url);
      for (const [key, value] of sourceParams.entries()) {
        if (!target.searchParams.has(key)) target.searchParams.set(key, value);
      }
      target.searchParams.set("experiment", experiment);
      target.searchParams.set("landing_variant", variant);
      return target.toString();
    } catch {
      return url;
    }
  }

  document.querySelectorAll("[data-cta]").forEach((el) => {
    el.href = withParams(bookingUrl);
    el.addEventListener("click", () => {
      window.fathom?.trackEvent("Calibration CTA Clicked");
    });
  });
})();
