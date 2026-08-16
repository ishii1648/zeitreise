/**
 * ラベル層の衝突制御 extension 構成（TASK-108）。
 *
 * deck.gl の `CollisionFilterExtension` は衝突判定を 0/1 ではなく
 * `pow(アンカー近傍 5x5 px の一致率, 2.2)` の連続値（`collision_fade`）で返し、
 * 色の alpha に乗算する。負けかけたラベルは中途半端な alpha で描かれ続け、
 * さらに TextLayer の SDF は halo の alpha を `outlineColor`（不透明なクリーム）
 * から取るため、「文字だけ薄れて白っぽい輪郭が残る」ゴーストになる。
 *
 * ここではその `collision_fade` を後段で二値化する小さな LayerExtension を足し、
 * ラベルを「読める」か「出ない」かの二択に倒す。閾値・GLSL 本体は labels.ts の
 * 純粋関数（labelCollisionCutoffInject）に置き、この層は deck.gl への配線だけを持つ。
 *
 * **順序が本質**: 我々の inject は `collision_fade` が計算された後に走る必要がある。
 * deck.gl の mergeShaders は shader module を extensions の順に concat し、
 * luma.gl の assembleShaders は「top-level inject → modules の inject」の順に
 * hook 本体を積む（order 同値なら安定ソートで順序維持）。したがって
 * collision 側が module で inject している以上、こちらも **module** で出したうえで
 * extensions 配列の後ろに置く必要がある。top-level `inject` で書くと
 * collision より先に走り、修正が丸ごと無効になる。
 */

import { LayerExtension, project } from "@deck.gl/core";
import type { Accessor, Layer, LayerContext } from "@deck.gl/core";
import { CollisionFilterExtension } from "@deck.gl/extensions";
import type { CollisionFilterExtensionProps } from "@deck.gl/extensions";
import {
  LABEL_COLLISION_FADE_CUTOFF,
  labelCollisionCutoffInject,
} from "./labels.ts";
import type { CollisionIdColor } from "./collision_id.ts";

/** 専用 collision ID accessor を追加した CollisionFilterExtension の props。 */
export type CollisionTextExtensionProps<DataT = unknown> =
  & CollisionFilterExtensionProps<DataT>
  & { getCollisionId?: Accessor<DataT, CollisionIdColor> };

/** collision shader が参照する専用属性名。background / characters の双方に付く。 */
export const LABEL_COLLISION_ID_ATTRIBUTE = "collisionIds";

/**
 * deck.gl 標準 collision shader と同じ処理を、比較色だけ専用 collisionIds に
 * 差し替えた shader module。通常 picking の geometry.pickingColor は変更しない。
 * collision map 描画時だけ、picking module の後段で出力色を collisionIds へ
 * 上書きするため hover / selected / picking index の契約を維持できる。
 */
const collisionWithLogicalIds = {
  name: "collision",
  dependencies: [project],
  vs: /* glsl */ `
in float collisionPriorities;
in vec3 collisionIds;

uniform sampler2D collision_texture;

layout(std140) uniform collisionUniforms {
  bool sort;
  bool enabled;
} collision;

vec2 collision_getCoords(vec4 position) {
  vec4 collision_clipspace = project_common_position_to_clipspace(position);
  return (1.0 + collision_clipspace.xy / collision_clipspace.w) / 2.0;
}

float collision_match(vec2 tex, vec3 collisionId) {
  vec4 collision_pickingColor = texture(collision_texture, tex);
  float delta = dot(abs(collision_pickingColor.rgb - collisionId), vec3(1.0));
  float e = 0.001;
  return step(delta, e);
}

float collision_isVisible(vec2 texCoords, vec3 collisionId) {
  if (!collision.enabled) {
    return 1.0;
  }

  const int N = 2;
  float accumulator = 0.0;
  vec2 step = vec2(1.0 / project.viewportSize);

  const float floatN = float(N);
  vec2 delta = -floatN * step;
  for(int i = -N; i <= N; i++) {
    delta.x = -step.x * floatN;
    for(int j = -N; j <= N; j++) {
      accumulator += collision_match(texCoords + delta, collisionId);
      delta.x += step.x;
    }
    delta.y += step.y;
  }

  float W = 2.0 * floatN + 1.0;
  return pow(accumulator / (W * W), 2.2);
}
`,
  inject: {
    "vs:#decl": /* glsl */ `
  float collision_fade = 1.0;
`,
    "vs:DECKGL_FILTER_GL_POSITION": /* glsl */ `
  if (collision.sort) {
    float collisionPriority = collisionPriorities;
    position.z = -0.001 * collisionPriority * position.w;
  }

  if (collision.enabled) {
    vec4 collision_common_position = project_position(vec4(geometry.worldPosition, 1.0));
    vec2 collision_texCoords = collision_getCoords(collision_common_position);
    collision_fade = collision_isVisible(collision_texCoords, collisionIds / 255.0);
    if (collision_fade < 0.0001) {
      position = vec4(0.0, 0.0, 2.0, 1.0);
    }
  }
  `,
    "vs:DECKGL_FILTER_COLOR": /* glsl */ `
  if (collision.sort) {
    picking_setPickingColor(collisionIds);
  }
  color.a *= collision_fade;
  `,
  },
  getUniforms: (
    opts: {
      enabled?: boolean;
      collisionFBO?: {
        colorAttachments: readonly unknown[];
      };
      drawToCollisionMap?: boolean;
      dummyCollisionMap?: unknown;
    } = {},
  ) => {
    if (!("dummyCollisionMap" in opts)) return {};
    const { enabled, collisionFBO, drawToCollisionMap, dummyCollisionMap } =
      opts;
    return {
      enabled: enabled && !drawToCollisionMap,
      sort: Boolean(drawToCollisionMap),
      collision_texture: !drawToCollisionMap && collisionFBO
        ? collisionFBO.colorAttachments[0]
        : dummyCollisionMap,
    };
  },
  uniformTypes: { sort: "i32", enabled: "i32" },
};

/**
 * TextLayer 用 CollisionFilterExtension。
 *
 * 標準 extension の effect・priority・collisionTestProps の実装は継承し、専用
 * collisionIds 属性と shader だけを足す。extension default prop の accessor は
 * CompositeLayer.getSubLayerProps により background / characters の両サブレイヤーへ
 * 同じ値として伝播し、1 論理ラベルの全グリフも startIndices により同じ ID を持つ。
 */
export class CollisionTextExtension extends CollisionFilterExtension {
  static override readonly extensionName = "CollisionTextExtension";
  static override readonly defaultProps = {
    ...CollisionFilterExtension.defaultProps,
    getCollisionId: { type: "accessor", value: [0, 0, 0] },
  };

  override getShaders(this: Layer<CollisionTextExtensionProps>): unknown {
    return { modules: [collisionWithLogicalIds] };
  }

  override initializeState(
    this: Layer<CollisionTextExtensionProps>,
    context: LayerContext,
    extension: this,
  ): void {
    super.initializeState(context, extension);
    this.getAttributeManager()?.add({
      [LABEL_COLLISION_ID_ATTRIBUTE]: {
        size: 3,
        type: "uint8",
        stepMode: "dynamic",
        accessor: "getCollisionId",
      },
    });
  }
}

/** 二値化 GLSL を運ぶだけのシェーダモジュール名（uniform も vs/fs 本体も持たない） */
export const LABEL_COLLISION_CUTOFF_MODULE_NAME = "labelCollisionCutoff";

/** LabelCollisionCutoffExtension のオプション */
export interface LabelCollisionCutoffOptions {
  /** 二値化の閾値。既定は labels.ts の LABEL_COLLISION_FADE_CUTOFF */
  cutoff: number;
}

/**
 * `CollisionFilterExtension` の後段に置き、`collision_fade` を二値化する
 * LayerExtension（TASK-108）。単体では意味を持たず、必ず
 * `CollisionFilterExtension` と組で、かつその**後ろ**に置いて使う
 * （labelCollisionExtensions がその組を返す唯一の入口）。
 */
export class LabelCollisionCutoffExtension
  extends LayerExtension<LabelCollisionCutoffOptions> {
  static override readonly extensionName = "LabelCollisionCutoffExtension";

  constructor(
    { cutoff = LABEL_COLLISION_FADE_CUTOFF }: Partial<
      LabelCollisionCutoffOptions
    > = {},
  ) {
    super({ cutoff });
  }

  override getShaders(this: Layer, extension: LabelCollisionCutoffExtension) {
    return {
      modules: [{
        name: LABEL_COLLISION_CUTOFF_MODULE_NAME,
        inject: labelCollisionCutoffInject(extension.opts.cutoff),
      }],
    };
  }
}

/**
 * 全ラベル TextLayer が共有する extensions（TASK-108）。順序に意味があるため
 * （モジュール冒頭のコメント参照）、必ずこの関数から組み立てる。
 * deck.gl は extension の同値判定を `constructor` と `opts` の deep equal で
 * 行うため、レンダリングのたびに新しいインスタンスを返しても再コンパイルは
 * 起きない（従来 `new CollisionFilterExtension()` を毎回作っていたのと同じ）。
 */
export function labelCollisionExtensions(): [
  CollisionTextExtension,
  LabelCollisionCutoffExtension,
] {
  return [new CollisionTextExtension(), new LabelCollisionCutoffExtension()];
}
