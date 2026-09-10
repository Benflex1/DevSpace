export interface MonacoWidgetDisposeEvent {
  onDidDispose(listener: () => void): { dispose(): void };
}

export interface MonacoOwnedModel {
  dispose(): void;
}

export function disposeModelsAfterWidget(widget: MonacoWidgetDisposeEvent, models: readonly MonacoOwnedModel[]): void {
  let subscription: { dispose(): void } | null = null;
  subscription = widget.onDidDispose(() => {
    subscription?.dispose();
    for (const model of models) model.dispose();
  });
}
