import { describe, expect, it } from "bun:test";
import { marker, Registry, resolveMarkers, } from "../src/index.js";
class UpperCase {
    name = "upper";
    async apply(input) {
        return typeof input === "string" ? input.toUpperCase() : input;
    }
}
function regWithUpper() {
    const r = new Registry();
    r.register("upper", new UpperCase());
    return r;
}
describe("resolveMarkers", () => {
    it("resolves a top-level marker", async () => {
        const r = regWithUpper();
        const v = marker("upper", "alice");
        const { value, applied } = await resolveMarkers(v, r, "field");
        expect(value).toBe("ALICE");
        expect(applied).toEqual([{ transformer: "upper", field: "field" }]);
    });
    it("resolves nested + array markers", async () => {
        const r = regWithUpper();
        const v = {
            name: marker("upper", "alice"),
            tags: [marker("upper", "admin"), "user"],
        };
        const { value, applied } = await resolveMarkers(v, r, "");
        expect(value).toEqual({ name: "ALICE", tags: ["ADMIN", "user"] });
        expect(applied.map((a) => a.field)).toEqual(["name", "tags[0]"]);
    });
    it("unknown marker → E_TRANSFORMER_MISSING", async () => {
        const r = new Registry();
        const v = marker("ghost", "x");
        await expect(resolveMarkers(v, r, "f")).rejects.toMatchObject({
            code: "E_TRANSFORMER_MISSING",
        });
    });
    it("object with extra keys is NOT a marker", async () => {
        const r = regWithUpper();
        const v = { $transformer: "upper", input: "x", extra: 1 };
        const { value, applied } = await resolveMarkers(v, r, "");
        expect(value).toEqual(v);
        expect(applied).toEqual([]);
    });
});
//# sourceMappingURL=transformer.test.js.map