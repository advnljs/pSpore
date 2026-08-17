export class CommandError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "CommandError";
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map