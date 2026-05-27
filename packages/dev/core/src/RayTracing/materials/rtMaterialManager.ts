import { type WebGPUEngine } from "core/Engines/webgpuEngine";
import { StorageBuffer } from "core/Buffers/storageBuffer";
import { Constants } from "core/Engines/constants";
import { type Scene } from "core/scene";
import { RtMaterialStride } from "../bvh/bvhTypes";
import { RtNoTex } from "./rtTextureManager";

/**
 * RTMaterial GPU struct layout (160 bytes = 10 × 16-byte vec4 slots, std430).
 *
 * Slot  Floats  Contents
 * ----  ------  --------
 *   0    0– 3   baseColor (vec3f) + baseMetalness (f32)
 *   1    4– 7   specularColor (vec3f) + specularRoughness (f32)
 *   2    8–11   emissionColor (vec3f) + emissionLuminance (f32)
 *   3   12–15   transmissionColor (vec3f) + transmissionDepth (f32)
 *   4   16–19   coatColor (vec3f) + coatWeight (f32)
 *   5   20–23   subsurfaceColor (vec3f) + subsurfaceWeight (f32)
 *   6   24–27   specularIor, transmissionWeight, geometryOpacity, geometryThinWalled
 *   7   28–31   coatRoughness, coatIor, subsurfaceRadius, fuzzWeight
 *   8   32–35   fuzzRoughness, baseDiffuseRoughness, specularWeight, coatDarkening
 *   9   36–39   _reserved[4] (future texture indices)
 */

/** Number of f32 values in one RTMaterial */
const RtMaterialFloats = RtMaterialStride / 4; // 176 / 4 = 44

// ---- Duck-typed interfaces for material introspection -----------------------
// We avoid a hard import of OpenPBRMaterial / PBRMaterial to keep this module
// engine-agnostic.  Instead we probe getClassName() and cast via unknown.

/** Minimal shape of Babylon.js PBRMaterial / PBRMetallicRoughnessMaterial */
interface IPBRProps {
    albedoColor?: { r: number; g: number; b: number }; // PBRMaterial base color
    baseColor?: { r: number; g: number; b: number }; // PBRMetallicRoughnessMaterial
    metallic?: number;
    roughness?: number;
    indexOfRefraction?: number;
    emissiveColor?: { r: number; g: number; b: number };
    emissiveIntensity?: number;
    microSurface?: number; // PBRMaterial: 1-roughness
    directIntensity?: number;
}

/** Minimal shape of Babylon.js StandardMaterial */
interface IStandardProps {
    diffuseColor?: { r: number; g: number; b: number };
    specularColor?: { r: number; g: number; b: number };
    specularPower?: number;
    emissiveColor?: { r: number; g: number; b: number };
}

interface IOpenPBRProps {
    baseColor: { r: number; g: number; b: number };
    baseMetalness: number;
    baseDiffuseRoughness: number;
    specularColor: { r: number; g: number; b: number };
    specularRoughness: number;
    specularIor: number;
    specularWeight: number;
    transmissionColor: { r: number; g: number; b: number };
    transmissionWeight: number;
    transmissionDepth: number;
    coatColor: { r: number; g: number; b: number };
    coatWeight: number;
    coatRoughness: number;
    coatIor: number;
    coatDarkening: number;
    emissionColor: { r: number; g: number; b: number };
    emissionLuminance: number;
    geometryOpacity: number;
    geometryThinWalled: number;
    subsurfaceColor: { r: number; g: number; b: number };
    subsurfaceWeight: number;
    subsurfaceRadius: number;
    fuzzWeight: number;
    fuzzRoughness: number;
    // Texture slots (may be absent on older builds)
    baseColorTexture?: { uniqueId: number } | null;
    specularRoughnessTexture?: { uniqueId: number } | null;
    baseMetalnessTexture?: { uniqueId: number } | null;
    emissionColorTexture?: { uniqueId: number } | null;
    geometryOpacityTexture?: { uniqueId: number } | null;
    // Channel-packing flags (set by the glTF loader when ORM textures are used)
    _useRoughnessFromMetallicTextureGreen?: boolean;
    _useMetallicFromMetallicTextureBlue?: boolean;
}

/**
 * Packs all materials in the scene into a GPU storage buffer.
 * Reads scalar and texture properties from OpenPBRMaterial instances.
 * All other material types receive physically-plausible defaults.
 *
 * Texture indices are packed into RTMaterial slots 9–10 using layer indices
 * from the RtTextureManager.  Call upload() with the texture manager's
 * texIndexMap after it has completed an async texture upload.
 */
export class RtMaterialManager {
    private readonly _engine: WebGPUEngine;
    private _buffer: StorageBuffer | null = null;
    private _capacity = 0;

    /** Maps material uniqueId → RTMaterial buffer index */
    public readonly materialIndexMap = new Map<number, number>();

    /**
     * Creates a new RtMaterialManager.
     * @param engine - The WebGPU engine used to create storage buffers
     */
    constructor(engine: WebGPUEngine) {
        this._engine = engine;
    }

    /** Returns the GPU storage buffer containing all RTMaterial entries */
    public get buffer(): StorageBuffer | null {
        return this._buffer;
    }

    /**
     * Rebuilds the material buffer from the scene's current material list.
     * Reads scalar OpenPBR properties directly from OpenPBRMaterial instances;
     * PBRMaterial gets a best-effort mapping, everything else gets safe defaults.
     *
     * @param scene The scene whose materials should be packed
     * @param texIndexMap Maps texture `uniqueId` → layer index in the GPU texture array.
     *   Pass `RtTextureManager.texIndexMap` after a successful texture upload.
     *   Slots for textures not in the map receive `RtNoTex` (no texture).
     */
    public upload(scene: Scene, texIndexMap: ReadonlyMap<number, number> = new Map()): void {
        const materials = scene.materials;
        const count = materials.length;

        this.materialIndexMap.clear();

        // Slot 0 is always the built-in default material (grey dielectric).
        // Meshes with no material assigned get materialIndex = 0 from the geometry
        // manager fallback, so they always receive safe defaults rather than
        // accidentally inheriting whatever the first scene material happens to be.
        // Real scene materials are packed starting at index 1.
        const total = count + 1;
        this._ensureBuffer(total);

        const flat = new Float32Array(total * RtMaterialFloats);

        // Index 0: built-in default
        this._packDefault(flat, 0);

        for (let i = 0; i < count; i++) {
            const mat = materials[i];
            // Offset by 1: index 0 is reserved for the default material.
            this.materialIndexMap.set(mat.uniqueId, i + 1);

            const base = (i + 1) * RtMaterialFloats;
            const cls = mat.getClassName?.() ?? "";

            if (cls === "OpenPBRMaterial") {
                this._packOpenPBR(flat, base, mat as unknown as IOpenPBRProps, texIndexMap);
            } else if (cls === "PBRMaterial" || cls === "PBRMetallicRoughnessMaterial") {
                this._packPBR(flat, base, mat as unknown as IPBRProps);
            } else if (cls === "StandardMaterial") {
                this._packStandard(flat, base, mat as unknown as IStandardProps);
            } else {
                this._packDefault(flat, base);
            }
        }

        this._buffer!.update(flat);
    }

    // ---- Private packing helpers --------------------------------------------

    /**
     * Pack a full OpenPBRMaterial into the flat buffer at `base`.
     * @param flat - The flat Float32Array buffer to write into
     * @param base - The starting index in the flat buffer
     * @param m - The OpenPBR material properties to pack
     * @param texIdx - Map from texture uniqueId to GPU texture array layer index
     */
    private _packOpenPBR(flat: Float32Array, base: number, m: IOpenPBRProps, texIdx: ReadonlyMap<number, number>): void {
        // Slot 0: baseColor + baseMetalness
        flat[base + 0] = m.baseColor.r;
        flat[base + 1] = m.baseColor.g;
        flat[base + 2] = m.baseColor.b;
        flat[base + 3] = m.baseMetalness ?? 0;

        // Slot 1: specularColor + specularRoughness
        const sc = m.specularColor ?? { r: 1, g: 1, b: 1 };
        flat[base + 4] = sc.r;
        flat[base + 5] = sc.g;
        flat[base + 6] = sc.b;
        flat[base + 7] = m.specularRoughness ?? 0.5;

        // Slot 2: emissionColor + emissionLuminance
        const ec = m.emissionColor ?? { r: 0, g: 0, b: 0 };
        flat[base + 8] = ec.r;
        flat[base + 9] = ec.g;
        flat[base + 10] = ec.b;
        flat[base + 11] = m.emissionLuminance ?? 0;

        // Slot 3: transmissionColor + transmissionDepth
        const tc = m.transmissionColor ?? { r: 1, g: 1, b: 1 };
        flat[base + 12] = tc.r;
        flat[base + 13] = tc.g;
        flat[base + 14] = tc.b;
        flat[base + 15] = m.transmissionDepth ?? 0;

        // Slot 4: coatColor + coatWeight
        const cc = m.coatColor ?? { r: 1, g: 1, b: 1 };
        flat[base + 16] = cc.r;
        flat[base + 17] = cc.g;
        flat[base + 18] = cc.b;
        flat[base + 19] = m.coatWeight ?? 0;

        // Slot 5: subsurfaceColor + subsurfaceWeight
        const ssc = m.subsurfaceColor ?? { r: 1, g: 1, b: 1 };
        flat[base + 20] = ssc.r;
        flat[base + 21] = ssc.g;
        flat[base + 22] = ssc.b;
        flat[base + 23] = m.subsurfaceWeight ?? 0;

        // Slot 6: specularIor, transmissionWeight, geometryOpacity, geometryThinWalled
        flat[base + 24] = m.specularIor ?? 1.5;
        flat[base + 25] = m.transmissionWeight ?? 0;
        flat[base + 26] = m.geometryOpacity ?? 1;
        flat[base + 27] = m.geometryThinWalled ?? 0;

        // Slot 7: coatRoughness, coatIor, subsurfaceRadius, fuzzWeight
        flat[base + 28] = m.coatRoughness ?? 0;
        flat[base + 29] = m.coatIor ?? 1.6;
        flat[base + 30] = m.subsurfaceRadius ?? 0;
        flat[base + 31] = m.fuzzWeight ?? 0;

        // Slot 8: fuzzRoughness, baseDiffuseRoughness, specularWeight, coatDarkening
        flat[base + 32] = m.fuzzRoughness ?? 0.5;
        flat[base + 33] = m.baseDiffuseRoughness ?? 0;
        flat[base + 34] = m.specularWeight ?? 1;
        flat[base + 35] = m.coatDarkening ?? 1;

        // Slot 9: texture indices A (as f32; RtNoTex = 65535 = no texture)
        const tx = (t: { uniqueId: number } | null | undefined) => (t ? (texIdx.get(t.uniqueId) ?? RtNoTex) : RtNoTex);
        flat[base + 36] = tx(m.baseColorTexture);
        flat[base + 37] = tx(m.specularRoughnessTexture);
        flat[base + 38] = tx(m.baseMetalnessTexture);
        flat[base + 39] = tx(m.emissionColorTexture);

        // Slot 10: texture index B + flags + normalScale
        flat[base + 40] = tx(m.geometryOpacityTexture);
        // Build texFlags from the channel-packing flags set by the glTF loader.
        // TEX_FLAG_ROUGHNESS_IN_GREEN (4): roughness is in the G channel of roughnessTexture.
        // TEX_FLAG_METALLIC_IN_BLUE  (8): metalness is in the B channel of metallicTexture.
        // These match the WGSL constants in rtCommonWgsl.ts.
        let texFlags = 0;
        if (m._useRoughnessFromMetallicTextureGreen) {
            texFlags |= 4;
        }
        if (m._useMetallicFromMetallicTextureBlue) {
            texFlags |= 8;
        }
        flat[base + 41] = texFlags;
        flat[base + 42] = 1; // normalScale
        flat[base + 43] = 0; // pad
    }

    /**
     * Best-effort packing for Babylon.js PBRMaterial / PBRMetallicRoughnessMaterial.
     * Maps albedoColor → baseColor, metallic/roughness, and emissiveColor × emissiveIntensity.
     * @param flat - The flat Float32Array buffer to write into
     * @param base - The starting index in the flat buffer
     * @param m - The PBR material properties to pack
     */
    private _packPBR(flat: Float32Array, base: number, m: IPBRProps): void {
        // Start from defaults so any unmapped slots are valid.
        this._packDefault(flat, base);

        // Base color (albedoColor for PBRMaterial, baseColor for PBRMetallicRoughnessMaterial)
        const bc = m.albedoColor ?? m.baseColor ?? { r: 0.8, g: 0.8, b: 0.8 };
        flat[base + 0] = bc.r;
        flat[base + 1] = bc.g;
        flat[base + 2] = bc.b;
        flat[base + 3] = m.metallic ?? 0;

        // Roughness: PBRMaterial stores microSurface = 1 - roughness.
        const roughness = m.roughness ?? 1.0 - (m.microSurface ?? 0.5);
        flat[base + 7] = roughness;

        // IOR
        flat[base + 24] = m.indexOfRefraction ?? 1.5;

        // Emission: emissiveColor × emissiveIntensity
        const ec = m.emissiveColor ?? { r: 0, g: 0, b: 0 };
        const intensity = m.emissiveIntensity ?? 1;
        flat[base + 8] = ec.r * intensity;
        flat[base + 9] = ec.g * intensity;
        flat[base + 10] = ec.b * intensity;
        // emissionLuminance = 1 when emissiveColor is already in radiance units
        flat[base + 11] = ec.r + ec.g + ec.b > 0 ? 1 : 0;
    }

    /**
     * Best-effort packing for Babylon.js StandardMaterial.
     * Maps diffuseColor → baseColor and emissiveColor → emission.
     * @param flat - The flat Float32Array buffer to write into
     * @param base - The starting index in the flat buffer
     * @param m - The Standard material properties to pack
     */
    private _packStandard(flat: Float32Array, base: number, m: IStandardProps): void {
        this._packDefault(flat, base);

        const dc = m.diffuseColor ?? { r: 0.8, g: 0.8, b: 0.8 };
        flat[base + 0] = dc.r;
        flat[base + 1] = dc.g;
        flat[base + 2] = dc.b;

        // Emission
        const ec = m.emissiveColor ?? { r: 0, g: 0, b: 0 };
        flat[base + 8] = ec.r;
        flat[base + 9] = ec.g;
        flat[base + 10] = ec.b;
        flat[base + 11] = ec.r + ec.g + ec.b > 0 ? 1 : 0;
    }

    /**
     * Physically-plausible defaults for unrecognised material types.
     * @param flat - The flat Float32Array buffer to write into
     * @param base - The starting index in the flat buffer
     */
    private _packDefault(flat: Float32Array, base: number): void {
        // Slot 0: medium-grey diffuse, fully dielectric
        flat[base + 0] = 0.8;
        flat[base + 1] = 0.8;
        flat[base + 2] = 0.8;
        flat[base + 3] = 0; // baseMetalness

        // Slot 1: white specular tint, medium roughness
        flat[base + 4] = 1;
        flat[base + 5] = 1;
        flat[base + 6] = 1;
        flat[base + 7] = 0.5; // specularRoughness

        // Slot 2: no emission
        // flat[base + 8..11] = 0 (already zero-init)

        // Slot 3: white transmission tint, no transmission depth
        flat[base + 12] = 1;
        flat[base + 13] = 1;
        flat[base + 14] = 1;
        // flat[base + 15] = 0

        // Slot 4: white coat tint, no coat
        flat[base + 16] = 1;
        flat[base + 17] = 1;
        flat[base + 18] = 1;
        // flat[base + 19] = 0

        // Slot 5: white subsurface, no subsurface
        flat[base + 20] = 1;
        flat[base + 21] = 1;
        flat[base + 22] = 1;
        // flat[base + 23] = 0

        // Slot 6: IOR=1.5, no transmission, fully opaque, not thin-walled
        flat[base + 24] = 1.5; // specularIor
        // flat[base + 25..27] = 0
        flat[base + 26] = 1; // geometryOpacity

        // Slot 7: coatRoughness=0, coatIor=1.6
        flat[base + 29] = 1.6; // coatIor

        // Slot 8: specularWeight=1, coatDarkening=1
        flat[base + 32] = 0.5; // fuzzRoughness
        flat[base + 34] = 1; // specularWeight
        flat[base + 35] = 1; // coatDarkening

        // Slots 9-10: no textures (all NO_TEX = 65535)
        flat[base + 36] = RtNoTex; // baseColorTexIdx
        flat[base + 37] = RtNoTex; // roughnessTexIdx
        flat[base + 38] = RtNoTex; // metallicTexIdx
        flat[base + 39] = RtNoTex; // emissiveTexIdx
        flat[base + 40] = RtNoTex; // opacityTexIdx
        // flat[base + 41] = 0  texFlags (already zero)
        flat[base + 42] = 1; // normalScale
        // flat[base + 43] = 0  pad (already zero)
    }

    // ---- Buffer management --------------------------------------------------

    private _ensureBuffer(count: number): void {
        if (count <= this._capacity) {
            return;
        }
        this._buffer?.dispose();
        const capacity = Math.ceil(count * 1.5);
        this._buffer = new StorageBuffer(this._engine, capacity * RtMaterialStride, Constants.BUFFER_CREATIONFLAG_READWRITE, "rt_materials");
        this._capacity = capacity;
    }

    /** Releases the GPU buffer */
    public dispose(): void {
        this._buffer?.dispose();
        this._buffer = null;
        this.materialIndexMap.clear();
    }
}
