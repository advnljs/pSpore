// The main process names the interface language in the page URL; Chinese is
// what the markup is written in, so only English needs applying.
if (new URLSearchParams(window.location.search).get("lang") === "en") {
    document.documentElement.lang = "en";
    document.title = "pSpore · Starting";
    const close = document.querySelector(".close");
    close?.setAttribute("aria-label", "Cancel startup");
    if (close)
        close.title = "Cancel startup (Esc)";
    const tagline = document.querySelector(".brand p");
    if (tagline)
        tagline.textContent = "Let ideas grow, quietly.";
    const status = document.getElementById("status");
    if (status)
        status.textContent = "Preparing your workspace";
    document.querySelector(".track")?.setAttribute("aria-label", "Starting");
    const footer = document.querySelector("footer");
    const footerText = footer ? Array.from(footer.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) : undefined;
    if (footerText)
        footerText.nodeValue = "Local and unhurried";
}
document.querySelector(".close")?.addEventListener("click", () => window.close());
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
        window.close();
});
document.documentElement.dataset["ready"] = "true";
export {};
//# sourceMappingURL=splash.js.map