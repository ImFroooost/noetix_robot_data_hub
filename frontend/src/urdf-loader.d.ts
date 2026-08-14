declare module "urdf-loader" {
  import type { LoadingManager, Object3D } from "three";

  export interface URDFRobot extends Object3D {
    joints: Record<string, unknown>;
    setJointValue: (name: string, value: number) => void;
  }

  export default class URDFLoader {
    constructor(manager?: LoadingManager);
    packages: string | Record<string, string>;
    load(
      url: string,
      onLoad: (robot: URDFRobot) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (error: unknown) => void
    ): void;
    parse(data: string | Document): URDFRobot;
  }
}
