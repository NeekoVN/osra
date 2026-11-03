export class WaveTransition {
  private wavesViewport: HTMLElement | null;

  constructor() {
    this.wavesViewport = document.getElementById('waves-viewport');
  }

  public async run(beforeReveal: () => Promise<void>): Promise<void> {
    if (!this.wavesViewport) {
      await beforeReveal();
      return;
    }

    try {
      // Phase 1: COVER
      this.wavesViewport.classList.remove('is-revealing');
      this.wavesViewport.classList.add('is-covering');
      await new Promise<void>((resolve) => setTimeout(resolve, 1050));

      // Perform actions while 100% covered
      await beforeReveal();

      // Ensure browser & GPU paint is complete before reveal
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      // Phase 2: REVEAL
      this.wavesViewport.classList.remove('is-covering');
      this.wavesViewport.classList.add('is-revealing');
      await new Promise<void>((resolve) => setTimeout(resolve, 1050));

      this.wavesViewport.classList.remove('is-revealing');
    } finally {
      this.wavesViewport.classList.remove('is-covering', 'is-revealing');
    }
  }

  public reset(): void {
    this.wavesViewport?.classList.remove('is-covering', 'is-revealing');
  }
}
