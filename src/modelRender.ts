import { IModelShape } from "./GptModel";
import { genModelStructure } from "./GptModelLayout";
import { Mat4f } from "./utils/matrix";
import { createShaderProgram } from "./utils/shader";
import { Vec3 } from "./utils/vector";

export interface IRenderView {
    canvasEl: HTMLCanvasElement;
    camAngle: Vec3; // degrees about z axis, and above the x-y plane
    camTarget: Vec3;
    // where is the camera etc
    // what's the time
}

export type IRenderState = ReturnType<typeof initRender>;

export function initRender(canvasEl: HTMLCanvasElement) {
    // init shaders for various block types

    console.clear();
    let gl = canvasEl.getContext("webgl2", { antialias: true })!;

    let ext = {
        extColorBufferFloat: gl.getExtension("EXT_color_buffer_float"),
    };

    let quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
        1, -1,
        1, 1,
        -1, 1,
    ]), gl.STATIC_DRAW);

    let quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(quadVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);


    let blockShader = createShaderProgram(gl, 'block', /*glsl*/`#version 300 es
        precision highp float;
        uniform mat4 u_view;
        uniform mat4 u_model;
        uniform vec3 u_size;
        uniform vec3 u_offset;
        layout(location = 0) in vec3 a_position;
        layout(location = 1) in vec3 a_normal;
        out vec3 v_normal;
        out vec3 v_modelPos;
        void main() {
            vec3 model_pos = a_position * u_size + u_offset;
            gl_Position = u_view * u_model * vec4(model_pos, 1);
            v_normal = a_normal;
            v_modelPos = model_pos;
        }
    `, /*glsl*/`#version 300 es
        precision highp float;
        in vec3 v_normal;
        out vec4 o_color;
        in vec3 v_modelPos;
        uniform vec3 u_lightPos[3]; // in model space
        uniform vec3 u_lightColor[3]; // in model space
        uniform vec3 u_camPos; // in model space

        void main() {
            vec3 baseColor = vec3(0.3, 0.3, 0.6);
            vec3 color = baseColor * 0.5;

            for (int i = 0; i < 3; i++) {
                vec3 light_dir = normalize(u_lightPos[i] - v_modelPos);
                vec3 view_dir = normalize(u_camPos - v_modelPos);
                vec3 half_dir = normalize(light_dir + view_dir);
                vec3 reflect_dir = reflect(-light_dir, v_normal);
                vec3 diffuse = 0.2 * baseColor * max(dot(light_dir, v_normal), 0.0);
                vec3 specular = 0.1 * u_lightColor[i] * pow(max(dot(half_dir, v_normal), 0.0), 32.0);

                color += diffuse + specular;
            }

            o_color = vec4(color, 1);
        }
    `, ['u_view', 'u_model', 'u_size', 'u_offset', 'u_lightPos', 'u_camPos', 'u_lightColor'])!;

    let lightShader = createShaderProgram(gl, 'light', /*glsl*/`#version 300 es
        precision highp float;
        uniform mat4 u_view;
        uniform mat4 u_model;
        uniform vec3 u_size;
        uniform vec3 u_offset;
        layout(location = 0) in vec3 a_position;
        layout(location = 1) in vec3 a_normal;
        out vec3 v_normal;
        out vec3 v_modelPos;
        void main() {
            vec3 model_pos = a_position * u_size + u_offset;
            gl_Position = u_view * u_model * vec4(model_pos, 1);
            v_normal = a_normal;
            v_modelPos = model_pos;
        }
    `, /*glsl*/`#version 300 es
        precision highp float;
        in vec3 v_normal;
        out vec4 o_color;

        void main() {
            o_color = vec4(.9, .5, .5, 1);
        }
    `, ['u_view', 'u_model', 'u_size', 'u_offset'])!;


    let cubeGeom = genCubeGeom(gl);

    return {
        canvasEl,
        gl,
        cubeGeom,
        quadVao,
        quadVbo,
        blockShader,
        lightShader,
    };
}

export interface IGeom {
    name: string;
    vao: WebGLVertexArrayObject;
    vbo: WebGLBuffer;
    type: number; // gl.TRIANGLES etc
    numVerts: number;
}

export function genCubeGeom(gl: WebGL2RenderingContext): IGeom {
    let faceVerts = [-1, 1, -1, -1, 1, 1, 1, 1, -1, -1, 1, -1];

    let faces = [
        new Mat4f(),
        Mat4f.fromAxisAngle(new Vec3(1, 0), Math.PI / 2),
        Mat4f.fromAxisAngle(new Vec3(1, 0), Math.PI),
        Mat4f.fromAxisAngle(new Vec3(1, 0), -Math.PI / 2),
        Mat4f.fromAxisAngle(new Vec3(0, 1), Math.PI / 2),
        Mat4f.fromAxisAngle(new Vec3(0, 1), -Math.PI / 2),
    ];

    let arr = new Float32Array(6 * 6 * 3 * 2);
    let j = 0;
    for (let faceMtx of faces) {
        for (let i = 0; i < 6; i++) {
            let v = faceMtx.mulVec3Proj(new Vec3(faceVerts[i*2], faceVerts[i*2+1], -1));
            let n = faceMtx.mulVec3Proj(new Vec3(0, 0, -1));
            arr[j++] = v.x;
            arr[j++] = v.y;
            arr[j++] = v.z;
            arr[j++] = n.x;
            arr[j++] = n.y;
            arr[j++] = n.z;
        }
    }

    let vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    let vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 6 * 4, 0);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 6 * 4, 3 * 4);

    return { name: 'cube', vao, vbo, type: gl.TRIANGLES, numVerts: 36 };
}

export function renderModel(view: IRenderView, args: IRenderState, shape: IModelShape) {
    let { gl, blockShader, lightShader, canvasEl } = args;
    let layout = genModelStructure(shape);
    let cell = layout.cell;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasEl.width, canvasEl.height);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.enable(gl.DEPTH_TEST);

    let camZoom = view.camAngle.z;
    let angleX = view.camAngle.x * Math.PI / 180;
    let angleY = view.camAngle.y * Math.PI / 180;

    let dist = 200 * camZoom;
    let camZ = dist * Math.sin(angleY);
    let camX = dist * Math.cos(angleY) * Math.cos(angleX);
    let camY = dist * Math.cos(angleY) * Math.sin(angleX);

    let camLookat = view.camTarget;
    let camPos = new Vec3(camX, camY, camZ).add(camLookat);

    let lookAt = Mat4f.fromLookAt(camPos, camLookat, new Vec3(0, 0, 1));
    let persp = Mat4f.fromPersp(40, view.canvasEl.height / view.canvasEl.width, 20, 10000);
    let viewMtx = persp.mul(lookAt);
    let modelMtx = new Mat4f();

    let lightPos = [
        new Vec3(100, 400, 600),
        new Vec3(-200, -300, -300),
        new Vec3(200, -100, 0),
    ];
    let lightColor = [
        new Vec3(1, 0.2, 0.2),
        new Vec3(1, 0.2, 0.2),
        new Vec3(1, 0.2, 0.2),
    ];
    let lightPosArr = new Float32Array(3 * 3);
    let lightColorArr = new Float32Array(3 * 3);
    for (let i = 0; i < 3; i++) {
        modelMtx.mulVec3Proj(lightPos[i]).writeToBuf(lightPosArr, i * 3);
        modelMtx.mulVec3Proj(lightColor[i]).writeToBuf(lightColorArr, i * 3);
    }

    for (let light of lightPos) {
        gl.useProgram(lightShader.program);
        let locs = lightShader.locs;
        let geom = args.cubeGeom;
        gl.uniformMatrix4fv(locs.u_view, false, viewMtx);
        gl.uniformMatrix4fv(locs.u_model, false, modelMtx);
        gl.uniform3fv(locs.u_offset, light);
        gl.uniform3fv(locs.u_size, new Vec3(1, 1, 1).mul(3));
        gl.bindVertexArray(geom.vao);
        gl.drawArrays(geom.type, 0, geom.numVerts);
    }

    {
        let locs = blockShader.locs;
        let geom = args.cubeGeom;
        gl.useProgram(blockShader.program);

        gl.uniformMatrix4fv(locs.u_view, false, viewMtx);
        gl.uniformMatrix4fv(locs.u_model, false, modelMtx);
        gl.uniform3fv(locs.u_camPos, modelMtx.mulVec3Proj(camPos));

        gl.uniform3fv(locs.u_lightPos, lightPosArr);
        gl.uniform3fv(locs.u_lightColor, lightColorArr);

        for (let block of layout.blocks) {
            // using uniforms is just a quick & easy way to sort this out
            let pos = new Vec3(block.x, block.y, - block.z - block.cz * cell + layout.height);
            let size = new Vec3(block.cx * cell, block.cy * cell, block.cz * cell);

            // * 0.5 etc is to change the cube from [-1, 1] to [0, 1], and then can use pos & size
            gl.uniform3fv(locs.u_size, size.mul(0.5));
            gl.uniform3fv(locs.u_offset, pos.add(size.mul(0.5)));

            gl.bindVertexArray(geom.vao);
            gl.drawArrays(geom.type, 0, geom.numVerts);
        }
    }
}