import { type Scene } from "core/scene";
import { RawTexture2DArray } from "core/Materials/Textures/rawTexture2DArray";
import { Constants } from "core/Engines/constants";
import { Logger } from "core/Misc/logger";
import { GetTextureDataAsync } from "core/Misc/textureTools";
import { type BaseTexture } from "core/Materials/Textures/baseTexture";

/** Layer index stored in RTMaterial texture index fields when no texture is bound. */
export const RtNoTex = 0xffff;

/** Texture properties to probe on OpenPBRMaterial (duck-typed). */
const OpenPBRTexProps = ["baseColorTexture", "specularRoughnessTexture", "baseMetalnessTexture", "emissionColorTexture", "geometryOpacityTexture"] as const;

/**
 * Manages a `texture_2d_array` on the GPU that holds all material textures required by
 * the ray tracer megakernel.
 *
 * All textures are packed at a uniform tile size (RGBA8) computed dynamically as the
 * smallest power-of-two that covers the largest native texture in the set, capped at
 * `RtTextureManager.MAX_TILE_SIZE`.  After a successful upload, `texIndexMap` maps each
 * Babylon.js texture `uniqueId` to its zero-based layer index in the array.
 * RTMaterial fields that hold texture indices store `RtNoTex` (65535) for unbound slots.
 *
 * Usage (inside a FrameGraph task's execute callback):
 * ```typescript
 * texManager.requestUpload(scene);   // async — no-op if already uploading or unchanged
 * cs.setTexture("texArray", texManager.textureArray);  // always valid (fallback if uploading)
 * ```
 */
export class RtTextureManager {
    /**
     * Maximum tile size used when computing the dynamic tile size.
     * All textures in a single upload share one tile size (required by texture_2d_array).
     * The tile size is the largest native texture dimension in the set, rounded up to a
     * power of two, capped at this value.  Increase if your scene uses very high-res textures.
     */
    static readonly MAX_TILE_SIZE = 4096;

    private readonly _scene: Scene;
    private _textureArray: RawTexture2DArray | null = null;
    private readonly _fallbackArray: RawTexture2DArray;
    private _isUploading = false;
    /** Sorted list of uniqueIds from the last completed upload (for change detection). */
    private _uploadedTexIds: number[] = [];

    /**
     * Maps texture `uniqueId` → zero-based layer index in the GPU texture array.
     * Updated after each successful `requestUpload()` completes.
     */
    public readonly texIndexMap = new Map<number, number>();

    /**
     * Creates a new RtTextureManager.
     * @param scene - The scene whose material textures will be managed
     */
    constructor(scene: Scene) {
        this._scene = scene;
        // 1×1×1 white RGBA fallback — always valid to bind; NO_TEX checks in shader skip sampling.
        const white = new Uint8Array([255, 255, 255, 255]);
        this._fallbackArray = new RawTexture2DArray(white, 1, 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Constants.TEXTURE_LINEAR_LINEAR);
    }

    /**
     * The GPU `texture_2d_array` containing all material textures.
     * Returns the 1×1×1 white fallback while an async upload is in progress.
     * This property is always non-null and safe to bind every frame.
     */
    public get textureArray(): RawTexture2DArray {
        return this._textureArray ?? this._fallbackArray;
    }

    /**
     * Starts an async upload of all material textures found in the scene.
     * Safe to call every frame — the upload is a no-op when already in progress or
     * when the set of material textures has not changed since the last upload.
     *
     * Once complete, `texIndexMap` is updated so the next `RtMaterialManager.upload()`
     * call will include the correct texture layer indices.
     *
     * @param scene The scene whose materials should be scanned for textures
     */
    public requestUpload(scene: Scene): void {
        if (this._isUploading) {
            return;
        }

        const textures = this._collectTextures(scene);
        const texIds = textures.map((t) => t.uniqueId).sort((a, b) => a - b);

        // Skip upload when the texture set is unchanged
        if (texIds.length === this._uploadedTexIds.length && texIds.every((id, i) => id === this._uploadedTexIds[i])) {
            return;
        }

        this._isUploading = true;
        void (async () => {
            try {
                await this._uploadAsync(textures);
                this._uploadedTexIds = texIds;
            } catch (err: unknown) {
                Logger.Warn(`RtTextureManager: texture upload failed: ${err}`);
            } finally {
                this._isUploading = false;
            }
        })();
    }

    /** Disposes the GPU texture array and clears the index map. */
    public dispose(): void {
        this._textureArray?.dispose();
        this._fallbackArray.dispose();
        this._textureArray = null;
        this.texIndexMap.clear();
    }

    // ---- Private helpers ----------------------------------------------------

    /**
     * Collects all unique material textures from the scene, deduped by uniqueId.
     * @param scene - The scene to scan for material textures
     * @returns Array of unique BaseTexture instances used by OpenPBR materials
     */
    private _collectTextures(scene: Scene): BaseTexture[] {
        const seen = new Set<number>();
        const textures: BaseTexture[] = [];

        for (const mat of scene.materials) {
            const cls = mat.getClassName?.() ?? "";

            if (cls !== "OpenPBRMaterial") {
                continue;
            }
            const propList: readonly string[] = OpenPBRTexProps;

            const m = mat as unknown as Record<string, unknown>;
            for (const prop of propList) {
                const tex = m[prop] as BaseTexture | null | undefined;
                if (tex && typeof tex === "object" && "uniqueId" in tex) {
                    const id = (tex as BaseTexture).uniqueId;
                    if (!seen.has(id)) {
                        seen.add(id);
                        textures.push(tex as BaseTexture);
                    }
                }
            }
        }

        return textures;
    }

    /**
     * Reads each texture's pixel data, packs them into a flat Uint8Array, and creates the GPU texture array.
     * @param textures - The textures to upload
     */
    private async _uploadAsync(textures: BaseTexture[]): Promise<void> {
        // Compute tile size as the smallest power-of-two that fits the largest native texture,
        // capped at MAX_TILE_SIZE.  All layers in a texture_2d_array must share the same size.
        let maxDim = 1;
        for (const tex of textures) {
            const s = tex.getBaseSize();
            maxDim = Math.max(maxDim, s.width, s.height);
        }
        // Round up to the next power of two, then clamp.
        let tileSize = 1;
        while (tileSize < maxDim) {
            tileSize <<= 1;
        }
        tileSize = Math.min(tileSize, RtTextureManager.MAX_TILE_SIZE);

        const bytesPerLayer = tileSize * tileSize * 4;
        // Ensure at least one layer so the array is always non-empty.
        const layerCount = Math.max(textures.length, 1);
        const allData = new Uint8Array(layerCount * bytesPerLayer);

        // Fill all layers white as a default; individual layers will be overwritten.
        allData.fill(255);

        const newTexIndexMap = new Map<number, number>();

        // Fetch all textures in parallel to avoid sequential await-in-loop.
        const fetchResults = await Promise.all(
            textures.map(async (tex, i) => {
                try {
                    const data = await GetTextureDataAsync(tex, tileSize, tileSize);
                    return { i, tex, data, ok: true as const };
                } catch (e: unknown) {
                    Logger.Warn(`RtTextureManager: skipping texture "${tex.name}" (${tex.uniqueId}): ${e}`);
                    return { i, tex, data: null, ok: false as const };
                }
            })
        );

        for (const result of fetchResults) {
            if (result.ok) {
                allData.set(result.data.subarray(0, bytesPerLayer), result.i * bytesPerLayer);
                newTexIndexMap.set(result.tex.uniqueId, result.i);
            }
            // Failed layers stay white; uniqueId not added to map → material manager uses NO_TEX.
        }

        // Replace the old texture array with the new one.
        // Dispose after creation so the GPU resource is only released once the new one is ready.
        const newArray = new RawTexture2DArray(
            allData,
            tileSize,
            tileSize,
            layerCount,
            Constants.TEXTUREFORMAT_RGBA,
            this._scene,
            false, // generateMipMaps
            false, // invertY
            Constants.TEXTURE_LINEAR_LINEAR,
            Constants.TEXTURETYPE_UNSIGNED_BYTE
        );

        const old = this._textureArray;
        this._textureArray = newArray;
        this.texIndexMap.clear();
        for (const [id, idx] of Array.from(newTexIndexMap)) {
            this.texIndexMap.set(id, idx);
        }
        old?.dispose();
    }
}
