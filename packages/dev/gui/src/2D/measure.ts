import type { Matrix2D } from "./math2D";
import { Vector2 } from "core/Maths/math.vector";

const TmpRect = [new Vector2(0, 0), new Vector2(0, 0), new Vector2(0, 0), new Vector2(0, 0)];

const TmpRect2 = [new Vector2(0, 0), new Vector2(0, 0), new Vector2(0, 0), new Vector2(0, 0)];

const TmpV1 = new Vector2(0, 0);
const TmpV2 = new Vector2(0, 0);

/**
 * Class used to store 2D control sizes
 */
export class Measure {
    /**
     * Creates a new measure
     * @param left defines left coordinate
     * @param top defines top coordinate
     * @param width defines width dimension
     * @param height defines height dimension
     */
    public constructor(
        /** defines left coordinate */
        public left: number,
        /** defines top coordinate  */
        public top: number,
        /** defines width dimension  */
        public width: number,
        /** defines height dimension */
        public height: number
    ) {}

    /**
     * Copy from another measure
     * @param other defines the other measure to copy from
     */
    public copyFrom(other: Measure): void {
        this.left = other.left;
        this.top = other.top;
        this.width = other.width;
        this.height = other.height;
    }

    /**
     * Copy from a group of 4 floats
     * @param left defines left coordinate
     * @param top defines top coordinate
     * @param width defines width dimension
     * @param height defines height dimension
     */
    public copyFromFloats(left: number, top: number, width: number, height: number): void {
        this.left = left;
        this.top = top;
        this.width = width;
        this.height = height;
    }

    /**
     * Computes the axis aligned bounding box measure for two given measures
     * @param a Input measure
     * @param b Input measure
     * @param result the resulting bounding measure
     */
    public static CombineToRef(a: Measure, b: Measure, result: Measure) {
        const left = Math.min(a.left, b.left);
        const top = Math.min(a.top, b.top);
        const right = Math.max(a.left + a.width, b.left + b.width);
        const bottom = Math.max(a.top + a.height, b.top + b.height);
        result.left = left;
        result.top = top;
        result.width = right - left;
        result.height = bottom - top;
    }

    /**
     * Computes the axis aligned bounding box of the measure after it is modified by a given transform
     * @param transform the matrix to transform the measure before computing the AABB
     * @param addX number to add to left
     * @param addY number to add to top
     * @param addWidth number to add to width
     * @param addHeight number to add to height
     * @param result the resulting AABB
     */
    public addAndTransformToRef(transform: Matrix2D, addX: number, addY: number, addWidth: number, addHeight: number, result: Measure) {
        const left = this.left + addX;
        const top = this.top + addY;
        const width = this.width + addWidth;
        const height = this.height + addHeight;

        TmpRect[0].copyFromFloats(left, top);
        TmpRect[1].copyFromFloats(left + width, top);
        TmpRect[2].copyFromFloats(left + width, top + height);
        TmpRect[3].copyFromFloats(left, top + height);

        TmpV1.copyFromFloats(Number.MAX_VALUE, Number.MAX_VALUE);
        TmpV2.copyFromFloats(0, 0);
        for (let i = 0; i < 4; i++) {
            transform.transformCoordinates(TmpRect[i].x, TmpRect[i].y, TmpRect2[i]);
            TmpV1.x = Math.floor(Math.min(TmpV1.x, TmpRect2[i].x));
            TmpV1.y = Math.floor(Math.min(TmpV1.y, TmpRect2[i].y));
            TmpV2.x = Math.ceil(Math.max(TmpV2.x, TmpRect2[i].x));
            TmpV2.y = Math.ceil(Math.max(TmpV2.y, TmpRect2[i].y));
        }
        result.left = TmpV1.x;
        result.top = TmpV1.y;
        result.width = TmpV2.x - TmpV1.x;
        result.height = TmpV2.y - TmpV1.y;
    }

    /**
     * Computes the axis aligned bounding box of the measure after it is modified by a given transform
     * @param transform the matrix to transform the measure before computing the AABB
     * @param result the resulting AABB
     */
    public transformToRef(transform: Matrix2D, result: Measure) {
        this.addAndTransformToRef(transform, 0, 0, 0, 0, result);
    }
    /**
     * Check equality between this measure and another one
     * @param other defines the other measures
     * @returns true if both measures are equals
     */
    public isEqualsTo(other: Measure): boolean {
        if (this.left !== other.left) {
            return false;
        }

        if (this.top !== other.top) {
            return false;
        }

        if (this.width !== other.width) {
            return false;
        }

        if (this.height !== other.height) {
            return false;
        }

        return true;
    }

    /**
     * Creates an empty measure
     * @returns a new measure
     */
    public static Empty(): Measure {
        return new Measure(0, 0, 0, 0);
    }
}
