/**
 * deck.gl チャンク（#247 で分割した src/deck_app.ts）のロード失敗をユーザー
 * 告知へ繋ぐ結線（#319）。
 *
 * 背景: このチャンクの取得が失敗すると、地図はベースマップだけの状態になり
 * オーバーレイ（政治境界・都市・河川・山岳のポリゴンとラベル）が一切出ない。
 * 従来はこの縮退が console.error だけで、ユーザーには「データの無い地図」と
 * 区別がつかなかった。
 *
 * さらに、失敗した動的 import は HTML 仕様どおり文書の module map に失敗が
 * 記録され、同一 specifier の再 import は再フェッチされない（#311 の調査で
 * 実測）。つまりこの状態は終端であり、同一文書のままでの自力復帰手段は無い。
 * 復帰は新しい文書を作ること（＝ページの再読み込み）だけなので、告知は
 * 「再読み込みを促す」ものにする（src/ui/loading.ts）。
 *
 * decision-29 の方針どおり module-scope の可変状態は持たない。ロード状態の
 * 所有は main.ts に残し、ここはロード Promise と告知コールバックの結線だけを
 * 行う（DOM にも動的 import にも依存しないので、テストではローダを差し替えて
 * 失敗経路を再現できる）。
 */

/** {@linkcode watchDeckChunkLoad} へ注入する依存 */
export interface DeckChunkNoticeDeps<T> {
  /** deck.gl チャンクのロード（main.ts では動的 import 済みの Promise を返す） */
  load(): Promise<T>;
  /** ロード失敗をユーザーへ告知する（main.ts が loading_state 経由でトースト表示） */
  onFailure(error: unknown): void;
}

/**
 * ロードの失敗を監視して告知する。成功時は何もしない（通常経路は不変）。
 * 返す Promise は常に fulfill するので、呼び出し側で未処理 rejection にならない。
 */
export function watchDeckChunkLoad<T>(
  deps: DeckChunkNoticeDeps<T>,
): Promise<void> {
  return deps.load().then(
    () => {},
    (error: unknown) => {
      deps.onFailure(error);
    },
  );
}
