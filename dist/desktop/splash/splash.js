document.querySelector(".close")?.addEventListener("click", () => window.close());
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
        window.close();
});
document.documentElement.dataset["ready"] = "true";
export {};
//# sourceMappingURL=splash.js.map