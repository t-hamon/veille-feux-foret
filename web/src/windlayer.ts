// The wind on the map: a MapLibre custom layer that draws, with WebGL 2,
// either particles carried by the wind (animated) or arrows on the points of
// the wind grid (still). The geometry is computed in particles.ts; this module
// only drives the animation and uploads the vertices.
//
// The animation runs only while the layer is shown, animated, with wind for
// the chosen hour, and while the page is visible. It is paused on request
// (WCAG 2.2.2) and starts paused when the visitor asks for reduced motion.

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import {
  type Arrow,
  type Bounds,
  Particles,
  VERTEX_FLOATS,
  arrowFloats,
  arrowVertices,
  mercatorX,
  mercatorY,
  particleCount,
  rgb,
  seeded,
  trailFloats,
  trailVertices,
} from "./particles";
import { WIND_COLOURS } from "./palette";
import { type VectorSampler, type WindField, vectorsAt } from "./wind";

export const WIND_LAYER_ID = "vff-vent";

const TRAIL = 10;
/** Smallest distance between two arrows on screen, in pixels. */
const ARROW_SPACING = 44;
const ARROW_LENGTH = 22;
const COLOURS = WIND_COLOURS.map(rgb);

const VERTEX_SHADER = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
in vec4 a_colour;
out vec4 v_colour;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  v_colour = a_colour;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_colour;
out vec4 colour;
void main() {
  colour = v_colour;
}`;

export interface WindLayerHandle {
  layer: CustomLayerInterface;
  /** Wind of one hour of the file, or none. */
  setWind(field: WindField | null, hour: number | null): void;
  setAnimated(animated: boolean): void;
  setVisible(visible: boolean): void;
}

/** Product of a column-major 4x4 matrix and a translation by (x, y, 0). */
export function translated(matrix: ArrayLike<number>, x: number, y: number): Float32Array {
  const out = Float32Array.from(matrix);
  for (let row = 0; row < 4; row += 1) {
    out[12 + row] = (matrix[row] ?? 0) * x + (matrix[4 + row] ?? 0) * y + (matrix[12 + row] ?? 0);
  }
  return out;
}

/** Points of the wind grid to draw as arrows, every few points so that they do not crowd. */
export function arrowsInView(
  field: WindField,
  hour: number,
  bounds: Bounds,
  zoom: number,
): Arrow[] {
  const cellPixels = (field.step / 360) * 512 * 2 ** zoom;
  const stride = Math.max(1, Math.ceil(ARROW_SPACING / cellPixels));
  const arrows: Arrow[] = [];
  field.points.forEach(([lat, lon], index) => {
    const row = Math.round((lat - field.south) / field.step);
    const column = Math.round((lon - field.west) / field.step);
    if (row % stride !== 0 || column % stride !== 0) return;
    if (lat < bounds.south || lat > bounds.north || lon < bounds.west || lon > bounds.east) return;
    const speed = field.speed[index]?.[hour] ?? null;
    const from = field.direction[index]?.[hour] ?? null;
    if (speed === null || from === null) return;
    arrows.push({ lat, lon, from, speed });
  });
  return arrows;
}

function compile(gl: WebGL2RenderingContext): WebGLProgram | null {
  const program = gl.createProgram();
  const shaders = [
    [gl.VERTEX_SHADER, VERTEX_SHADER],
    [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
  ] as const;
  for (const [type, source] of shaders) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("Vent : programme WebGL non compilé :", gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

export function createWindLayer(map: MapLibreMap): WindLayerHandle {
  let field: WindField | null = null;
  let hour: number | null = null;
  let sampler: VectorSampler | null = null;
  let animated = true;
  let visible = false;
  let particles: Particles | null = null;
  let vertices = new Float32Array(0);
  let frame = 0;
  let previous = 0;

  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  /** Floats the GPU buffer can hold. */
  let allocated = 0;
  let vao: WebGLVertexArrayObject | null = null;
  let matrixLocation: WebGLUniformLocation | null = null;

  function viewBounds(): Bounds | null {
    if (!field) return null;
    const view = map.getBounds();
    const bounds = {
      west: Math.max(view.getWest(), field.west),
      south: Math.max(view.getSouth(), field.south),
      east: Math.min(view.getEast(), field.west + (field.columns - 1) * field.step),
      north: Math.min(view.getNorth(), field.south + (field.rows - 1) * field.step),
    };
    return bounds.west < bounds.east && bounds.south < bounds.north ? bounds : null;
  }

  function running(): boolean {
    return visible && animated && sampler !== null && document.visibilityState === "visible";
  }

  function tick(time: number): void {
    frame = 0;
    if (!running() || !sampler) return;
    const bounds = viewBounds();
    if (bounds) {
      if (!particles) {
        const canvas = map.getCanvas();
        particles = new Particles(
          particleCount(canvas.clientWidth, canvas.clientHeight),
          TRAIL,
          seeded(1),
        );
        particles.reset(bounds, sampler);
      }
      // Frames of 1/60 s since the last one; a long gap (hidden tab) counts as one.
      const frames = previous === 0 ? 1 : Math.min(3, (time - previous) / (1000 / 60));
      particles.step(bounds, sampler, map.getZoom(), frames);
    }
    previous = time;
    map.triggerRepaint();
    frame = requestAnimationFrame(tick);
  }

  function update(): void {
    if (running()) {
      if (frame === 0) {
        previous = 0;
        frame = requestAnimationFrame(tick);
      }
    } else if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    map.triggerRepaint();
  }

  document.addEventListener("visibilitychange", update);

  function upload(
    context: WebGL2RenderingContext,
    floats: number,
    origin: [number, number],
    options: CustomRenderMethodInput,
  ): void {
    if (!program || !buffer || !vao || floats === 0) return;
    context.useProgram(program);
    context.uniformMatrix4fv(
      matrixLocation,
      false,
      translated(options.defaultProjectionData.mainMatrix, origin[0], origin[1]),
    );
    context.bindVertexArray(vao);
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    // The buffer is allocated once at the largest size needed, then only
    // overwritten: the trails are uploaded at every frame.
    if (floats > allocated) {
      allocated = vertices.length;
      context.bufferData(context.ARRAY_BUFFER, allocated * 4, context.DYNAMIC_DRAW);
    }
    context.bufferSubData(context.ARRAY_BUFFER, 0, vertices, 0, floats);
    context.drawArrays(context.TRIANGLES, 0, floats / VERTEX_FLOATS);
    context.bindVertexArray(null);
  }

  const layer: CustomLayerInterface = {
    id: WIND_LAYER_ID,
    type: "custom",
    renderingMode: "2d",
    onAdd(_map, context) {
      gl = context;
      program = compile(context);
      buffer = context.createBuffer();
      vao = context.createVertexArray();
      if (!program) return;
      matrixLocation = context.getUniformLocation(program, "u_matrix");
      context.bindVertexArray(vao);
      context.bindBuffer(context.ARRAY_BUFFER, buffer);
      const stride = VERTEX_FLOATS * 4;
      const position = context.getAttribLocation(program, "a_pos");
      const colour = context.getAttribLocation(program, "a_colour");
      context.enableVertexAttribArray(position);
      context.vertexAttribPointer(position, 2, context.FLOAT, false, stride, 0);
      context.enableVertexAttribArray(colour);
      context.vertexAttribPointer(colour, 4, context.FLOAT, false, stride, 8);
      context.bindVertexArray(null);
    },
    onRemove() {
      allocated = 0;
      if (gl) {
        gl.deleteBuffer(buffer);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
      }
      gl = null;
      program = null;
      buffer = null;
      vao = null;
    },
    render(context, options) {
      if (!visible || !field || hour === null || !sampler) return;
      const centre = map.getCenter();
      const origin: [number, number] = [mercatorX(centre.lng), mercatorY(centre.lat)];
      // Size of a CSS pixel in Mercator units at this zoom.
      const pixel = 1 / (512 * 2 ** map.getZoom());
      if (animated) {
        if (!particles) return;
        const needed = trailFloats(particles);
        if (vertices.length < needed) vertices = new Float32Array(needed);
        upload(
          context,
          trailVertices(particles, vertices, origin, pixel, COLOURS),
          origin,
          options,
        );
        return;
      }
      const bounds = viewBounds();
      if (!bounds) return;
      const arrows = arrowsInView(field, hour, bounds, map.getZoom());
      const needed = arrowFloats(arrows.length);
      if (vertices.length < needed) vertices = new Float32Array(needed);
      upload(
        context,
        arrowVertices(arrows, vertices, origin, pixel, ARROW_LENGTH, COLOURS),
        origin,
        options,
      );
    },
  };

  return {
    layer,
    setWind(nextField, nextHour) {
      const newFile = nextField !== field;
      if (!newFile && nextHour === hour) {
        update();
        return;
      }
      field = nextField;
      hour = nextHour;
      sampler = field && hour !== null ? vectorsAt(field, hour) : null;
      // Another hour: the particles follow the new wind from where they are.
      // Another file: they start again.
      if (newFile) particles = null;
      update();
    },
    setAnimated(value) {
      animated = value;
      update();
    },
    setVisible(value) {
      visible = value;
      if (!value) particles = null;
      update();
    },
  };
}
