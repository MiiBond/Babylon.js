import { Nullable } from "babylonjs/types";
import { Color3 } from "babylonjs/Maths/math";
// import { Mesh } from "babylonjs/Meshes/mesh";
// import { TransformNode } from "babylonjs/Meshes/transformNode";
import { PBRMaterial } from "babylonjs/Materials/PBR/pbrMaterial";
import { Material } from "babylonjs/Materials/material";
import { BaseTexture } from "babylonjs/Materials/Textures/baseTexture";

// import { IChildRootProperty } from "babylonjs-gltf2interface";
import { IMaterial, ITextureInfo } from "../glTFLoaderInterfaces";
import { IGLTFLoaderExtension } from "../glTFLoaderExtension";
import { GLTFLoader } from "../glTFLoader";
// import { PBRBaseMaterial } from 'babylonjs/Materials/PBR/pbrBaseMaterial';

const NAME = "ADOBE_materials_thin_transparency";

interface IAdobeMaterialsThinTransparency {
  transmissionFactor?: number;
  transmissionTexture?: ITextureInfo;
  ior?: number;
  density?: number;
  interiorColor?: number[];
}

export class ADOBE_materials_thin_transparency implements IGLTFLoaderExtension {
  /** The name of this extension. */
  public readonly name = NAME;

  /** Defines whether this extension is enabled. */
  public enabled = true;

  private _loader: GLTFLoader;

  constructor(loader: GLTFLoader) {
    this._loader = loader;
    (loader as any)._parent.transparencyAsCoverage = true;

  }

  /** @hidden */
  public onLoading(): void {
    const extensions = this._loader.gltf.extensions;
    if (extensions && extensions[this.name]) {
      // const extension = extensions[this.name] as IAdobeMaterialsThinTransparency;
      // this._lights = extension.lights;
    }
  }

  /** @hidden */
  public dispose() {
    delete this._loader;
    // delete this._lights;
  }

  /** @hidden */
  public loadMaterialPropertiesAsync(context: string, material: IMaterial, babylonMaterial: Material): Nullable<Promise<void>> {
    return GLTFLoader.LoadExtensionAsync<IAdobeMaterialsThinTransparency>(context, material, this.name, (extensionContext, extension) => {
      console.log(extensionContext);
      const promises = new Array<Promise<any>>();
      promises.push(this._loader.loadMaterialBasePropertiesAsync(context, material, babylonMaterial));
      promises.push(this._loader.loadMaterialPropertiesAsync(context, material, babylonMaterial));
      promises.push(this._loadTransparentPropertiesAsync(context, material, babylonMaterial, extension));
      return Promise.all(promises).then(() => { });
    });
  }

  private _loadTransparentPropertiesAsync(context: string, material: IMaterial, babylonMaterial: Material, extension: IAdobeMaterialsThinTransparency): Promise<void> {
    if (!(babylonMaterial instanceof PBRMaterial)) {
      throw new Error(`${context}: Material type not supported`);
    }
    // const promises = [];
    // if (material.extensions && material.extensions.ADOBE_materials_thin_transparency) {

    console.log(extension);
    console.log(babylonMaterial);

    // const transparencyExtension = material.extensions.ADOBE_materials_thin_transparency;
    let pbrMaterial = babylonMaterial as PBRMaterial;
    pbrMaterial.transparency.isEnabled = true;
    // pbrMaterial.transparencyMode = PBRBaseMaterial.PBRMATERIAL_OPAQUE;
    pbrMaterial.subSurface.tintColor = pbrMaterial.albedoColor;
    pbrMaterial.backFaceCulling = false;
    pbrMaterial.twoSidedLighting = true;
    pbrMaterial.enableSpecularAntiAliasing = false;

    // Don't let the material gather RT's because, if it does, the scene will try to render the RT for the refractionTexture.
    pbrMaterial.getRenderTargetTextures = null;

    if (extension.transmissionFactor !== undefined) {
      pbrMaterial.transparency.factor = extension.transmissionFactor;
    }

    if (extension.ior !== undefined) {
      pbrMaterial.indexOfRefraction = 1.0 / extension.ior;
    }

    if (extension.density !== undefined) {
      pbrMaterial.transparency.interiorDensity = extension.density;
    }

    if (extension.interiorColor !== undefined) {
      pbrMaterial.transparency.interiorColor = Color3.FromArray(extension.interiorColor);
    }

    if (extension.transmissionTexture) {
      return this._loader.loadTextureInfoAsync(context, extension.transmissionTexture)
        .then((texture: BaseTexture) => {
          pbrMaterial.transparency.texture = texture;
          pbrMaterial.transparency.texture.getAlphaFromRGB = true;
        });
    } else {
      return Promise.resolve();
    }

    // Record the materials for use by node-loading.
    // const pbrMaterial = babylonMaterial as PBRMaterial;
    // const transparencyMaterial = new PBRMaterial(babylonMaterial.name, this._loader.babylonScene);
    // this.viewer.sceneManager.scene.removeMaterial(babylonMaterial);
    // const transparencyExtension = material.extensions.ADOBE_materials_thin_transparency;
    // transparencyMaterial.linkRefractionWithTransparency = false;
    // transparencyMaterial.alpha = 1;
    // // transparencyMaterial.opticalTransmission = transparencyExtension.transmissionFactor !== undefined ? transparencyExtension.transmissionFactor : 1.0;
    // transparencyMaterial.sideOrientation = Material.ClockWiseSideOrientation;
    // transparencyMaterial.twoSidedLighting = false;
    // transparencyMaterial.backFaceCulling = true;
    // transparencyMaterial.indexOfRefraction = 1.0 / transparencyExtension.ior;
    // transparencyMaterial.zOffset = 1;
    // transparencyMaterial.useSpecularOverAlpha = false;
    // transparencyMaterial.useRadianceOverAlpha = false;
    // const interiorProps = (material.extras && material.extras.ADOBE_transparency) ? material.extras.ADOBE_transparency : {};
    // const density = interiorProps.density || 0;
    // interiorColor.scaleToRef(Math.min(density, 1), interiorColor);
    // if (density) {
    // transparencyMaterial.interiorColor.copyFromFloats(interiorProps.interiorColor[0], interiorProps.interiorColor[1], interiorProps.interiorColor[2]);
    // transparencyMaterial.interiorDensity = density;
    // }
    // We need a tint pass if this material is anything other than white.
    // const needsTint = !!(material.pbrMetallicRoughness.baseColorFactor || material.pbrMetallicRoughness.baseColorTexture);
    // const needsSeparateGloss = (transparencyExtension.transmissionFactor !== undefined) || transparencyExtension.transmissionTexture;
    // return this._loader.loadMaterialPropertiesAsync(context, material, pbrMaterial);
    // .then(() => {

    //   const createBacksideMaterial = (transparencyMaterial: PBRMaterial) => {
    //     const backsideMaterial = transparencyMaterial.clone(transparencyMaterial.name + "_back");
    //     backsideMaterial.sideOrientation = Material.CounterClockWiseSideOrientation;
    //     backsideMaterial.backFaceCulling = true;
    //     backsideMaterial.twoSidedLighting = false;
    //     backsideMaterial.zOffset = 1;
    //     backsideMaterial.forceNormalForward = true;
    //     // backsideMaterial.interiorDensity = 0.0;
    //     // this.renderer.multiPassMaterials[material.index] = {backside: backsideMaterial, frontside: transparencyMaterial};
    //   }
    //   if (transparencyExtension.transmissionTexture) {
    //     return this._loader.loadTextureInfoAsync(context, transparencyExtension.transmissionTexture).then((texture: BaseTexture) => {
    //       texture.getAlphaFromRGB = true;
    //       // transparencyMaterial.transmissionTexture = texture;
    //       createBacksideMaterial(transparencyMaterial);
    //     });
    //   } else {
    //     createBacksideMaterial(transparencyMaterial);
    //     return Promise.resolve();
    //   }
    // });
    // } else {
    //   return this._loader.loadMaterialPropertiesAsync(context, material, babylonMaterial);
    // .then(() => {

    //   if (babylonMaterial.needAlphaBlending()) {
    //     const pbrMaterial = babylonMaterial as PBRMaterial;
    //     pbrMaterial.sideOrientation = Mesh.FRONTSIDE;
    //     pbrMaterial.twoSidedLighting = false;
    //     const backsideMaterial = pbrMaterial.clone(pbrMaterial.name + "_back");
    //     backsideMaterial.sideOrientation = Mesh.BACKSIDE;
    //     backsideMaterial.backFaceCulling = true;
    //     backsideMaterial.twoSidedLighting = false;
    //     // this.renderer.multiPassMaterials[material.index] = {backside: backsideMaterial, frontside: pbrMaterial};
    //   }
    //   return Promise.resolve();
    // });

  }
}

GLTFLoader.RegisterExtension(NAME, (loader) => new ADOBE_materials_thin_transparency(loader));
