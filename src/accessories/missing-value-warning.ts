/**
 * A getter is read by every controller, every few seconds: a value that is
 * missing is reported when it starts to be missing, not at every read while
 * it stays so, and again if it goes missing after having been available.
 */
export class MissingValueWarning {
    private warned = false;

    /** Whether to warn now. Call it at every read, with whether the value is missing. */
    public shouldWarn(missing: boolean): boolean {
        if (!missing) {
            this.warned = false;
            return false;
        }
        if (this.warned) return false;
        this.warned = true;
        return true;
    }
}
