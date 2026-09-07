declare module "urdf-loader" {
  import type { LoadingManager, Mesh, Object3D } from "three";

  export interface URDFRobot extends Object3D {
    joints: Record<string, unknown>;
    setJointValue: (name: string, value: number) => void;
  }

  export default class URDFLoader {
    constructor(manager?: LoadingManager);
    packages: string | Record<string, string> | ((pkg: string) => string);
    workingPath: string;
    parseVisual: boolean;
    parseCollision: boolean;
    fetchOptions: RequestInit;
    loadMeshCb: (
      path: string,
      manager: LoadingManager,
      done: (mesh: Mesh | Object3D | null, error?: unknown) => void
    ) => void;
    load(
      url: string,
      onLoad: (robot: URDFRobot) => void,
      onProgress?: (event: ProgressEvent) => void,
      onError?: (error: unknown) => void
    ): void;
    parse(data: string | Document, workingPath?: string): URDFRobot;
  }
}
