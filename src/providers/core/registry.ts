import type { AnyProvider, Capability, Provider } from "./types"

export class ProviderRegistry {
  private readonly providers = new Map<string, AnyProvider>()

  register<Caps extends readonly Capability[]>(provider: Provider<Caps>): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`provider '${provider.id}' already registered`)
    }
    this.providers.set(provider.id, provider)
  }

  get(id: string): AnyProvider {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error(`provider '${id}' not registered`)
    }
    return provider
  }

  list(): AnyProvider[] {
    return [...this.providers.values()]
  }

  listByCapability(capability: Capability): AnyProvider[] {
    return this.list().filter((p) => p.capabilities.includes(capability))
  }
}
