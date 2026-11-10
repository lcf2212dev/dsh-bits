/**
 * Bits — browser half of the `@dsh-burn-plugins/dsh-bots` bundle.
 *
 * Contributes a "Bits" entry to the sidebar's global panel list and a full page
 * in the layout's `main` keyed slot. The page has three tabs: Bits (bit
 * definitions: catalog character, context/instructions, model, effort and the
 * orchestrator flag; workers can also be run ad-hoc with "Executar"), Times
 * (flow teams whose members reference bits) and Projects (teams grouped by
 * project).
 *
 * This file is a plain browser module: no JSX, no imports, no Harness package
 * requires. Only `react` comes from the shared module table. Every registration
 * lives inside `apply`; the factory itself has no side effects.
 *
 * Locale dictionaries are inline (pt primary, en complete) and registered
 * through `ctx.locale.register`. Styling is one React `<style>` element whose
 * values are the Host theme tokens (`--dsw-alias-*`) with CSS fallbacks.
 */
window.__ModuleLoader__.load({
  id: '@dsh-burn-plugins/dsh-bots',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------------------------ */
    /* Constants                                                          */
    /* ------------------------------------------------------------------ */

    /** Dictionary namespace owned by this bundle. */
    const NS = 'bots'
    /** Id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'bots'
    /** Field limits mirroring the record contract (V5-CONTRACT.md §2). */
    const MAX_NAME = 60
    const MAX_INSTRUCTIONS = 20000
    /** Ad-hoc request limit mirrored from the run route (§7). */
    const MAX_REQUEST = 20000
    /** Catalog id of the brand mascot (empty state and generic bit). */
    const MASCOT_ID = 'bit-mascot'
    /** Execution defaults per bit family (V5-CONTRACT.md §1 and §2). */
    const DEFAULT_WORKER_MODEL = 'subscription/sonnet'
    const DEFAULT_WORKER_EFFORT = 'high'
    const DEFAULT_ORCHESTRATOR_MODEL = 'deepseek-account/deepseek-flash'
    const DEFAULT_ORCHESTRATOR_EFFORT = 'max'
    /** Fallback effort list when the model reports none (V5-CONTRACT.md §1). */
    const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
    /** Hex colour palette offered by the form; the Host picks from its own fixed palette. */
    const COLOR_PALETTE = [
      '#7c3aed', '#2563eb', '#0891b2', '#059669', '#65a30d',
      '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#475569',
    ]

    /* ------------------------------------------------------------------ */
    /* Locale dictionaries                                                */
    /* ------------------------------------------------------------------ */

    /** Brazilian Portuguese — primary copy for this deployment. */
    const PT = {
      lang: 'pt',
      panel: 'Bits',
      title: 'Bits',
      subtitle: 'Bits são definições de agente: contexto, modelo e esforço. Use-os em fluxos na aba Times ou execute um pedido avulso com os workers.',
      newBot: 'Novo bit',
      editBot: 'Editar bit',
      create: 'Criar bit',
      edit: 'Editar',
      delete: 'Excluir bit',
      deleteTitle: 'Excluir {name}?',
      deleteBody: 'O bit será removido da lista. Os times que o referenciam ficam com o membro sem bit até você escolher outro.',
      deleteFiles: 'Também apagar os arquivos do workspace',
      deleteConfirm: 'Excluir bit',
      cancel: 'Cancelar',
      save: 'Salvar',
      saving: 'Salvando…',
      name: 'Nome',
      namePlaceholder: 'Ex.: Pesquisador',
      nameRequired: 'Informe um nome para o bit.',
      nameTooLong: 'O nome deve ter no máximo 60 caracteres.',
      pickCharacter: 'Escolha um bit',
      pickCharacterHint: 'Cada bit já vem com uma descrição pronta para a função. Você pode mudar o nome e a descrição depois.',
      searchCharacters: 'Buscar por função, nome ou habilidade',
      noCharacters: 'Nenhum bit encontrado para “{query}”.',
      changeCharacter: 'Trocar bit',
      chooseCharacter: 'Escolher bit',
      noCharacter: 'Sem personagem',
      noCharacterHint: 'Este bit não usa um personagem do catálogo. Escolha um para herdar as instruções e o avatar.',
      catalogLoading: 'Carregando os bits…',
      catalogError: 'Não foi possível carregar os bits.',
      continueWithout: 'Continuar sem personagem',
      back: 'Voltar',
      otherGroup: 'Outros',
      instructions: 'Descrição',
      instructionsHint: 'Contexto do bit (persona e instruções), enviado em todas as execuções. Edite à vontade (até 20.000 caracteres).',
      instructionsPlaceholder: 'Descreva a função, o jeito de trabalhar e os limites deste bit…',
      restoreDefault: 'Restaurar descrição padrão',
      instructionsTooLong: 'As instruções devem ter no máximo 20.000 caracteres.',
      noInstructions: 'Sem instruções ainda.',
      orchestrator: 'Orquestrador',
      worker: 'Worker',
      isOrchestrator: 'Orquestrador',
      isOrchestratorHint: 'Orquestradores coordenam fluxos: rodam como agentes DSH e são os únicos que podem liderar um time. Workers recebem um pedido e devolvem uma resposta única.',
      model: 'Modelo',
      modelHint: 'Modelo usado nas execuções. Orquestradores usam rotas de chat do DSH; workers podem usar a assinatura do Claude Code (claude_delegate) ou uma rota DSH.',
      effort: 'Esforço',
      effortHint: 'Esforço de raciocínio aplicado ao modelo (varia por modelo).',
      modelGroupSubscription: 'Assinatura (Claude Code)',
      modelGroupRoutes: 'Rotas do DSH',
      modelsLoading: 'Carregando modelos…',
      modelsError: 'Não foi possível carregar os modelos.',
      modelMissing: 'O modelo “{id}” não está disponível neste perfil.',
      modelRequired: 'Escolha um modelo.',
      modelOrchestratorRequired: 'Orquestradores precisam de uma rota de chat do DSH.',
      noModels: 'O host não oferece modelos agora.',
      execute: 'Executar',
      executeTitle: 'Executar {name}',
      executeHint: 'Um pedido avulso: o bit recebe o texto e devolve uma resposta única.',
      runRequest: 'Pedido',
      runRequestPlaceholder: 'Descreva o pedido com o contexto necessário…',
      runReadOnly: 'Somente leitura',
      runReadOnlyHint: 'Sem permissão de escrita no workspace do bit: o worker apenas lê e responde.',
      runSubmit: 'Executar',
      runRunning: 'Executando…',
      runResponse: 'Resposta',
      runResponseEmpty: 'A resposta aparece aqui.',
      runClose: 'Fechar',
      runsInFlows: 'Executa em fluxos (aba Times).',
      leadInTeams: 'Líder em: {names}',
      leadInTeamsNone: 'Ainda não lidera nenhum time.',
      openTeamsTab: 'Abrir Times',
      loading: 'Carregando bits…',
      empty: 'Nenhum bit ainda',
      emptyHint: 'Crie um bit (Scout, Builder, Product Owner, …) para usá-lo em um fluxo ou executar um pedido avulso.',
      error: 'Não foi possível carregar os bits.',
      retry: 'Tentar novamente',
      confirm: 'Confirmar',
      deleted: 'Bit excluído.',
      deletedWorkspace: 'Bit excluído e workspace apagado.',
      saved: 'Alterações salvas.',
      created: 'Bit criado.',
      failed: 'Falhou',
      refresh: 'Atualizar',
      refreshing: 'Atualizando…',
      working: 'Processando…',
      close: 'Fechar',
    }

    /** English — complete fallback dictionary (same keys as PT). */
    const EN = {
      lang: 'en',
      panel: 'Bits',
      title: 'Bits',
      subtitle: 'Bits are agent definitions: context, model and effort. Use them in flows on the Teams tab or run an ad-hoc request with workers.',
      newBot: 'New bit',
      editBot: 'Edit bit',
      create: 'Create bit',
      edit: 'Edit',
      delete: 'Delete bit',
      deleteTitle: 'Delete {name}?',
      deleteBody: 'The bit will be removed from the list. Teams referencing it keep the member without a bit until you pick another.',
      deleteFiles: 'Also delete the workspace files',
      deleteConfirm: 'Delete bit',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      name: 'Name',
      namePlaceholder: 'E.g. Researcher',
      nameRequired: 'Enter a name for the bit.',
      nameTooLong: 'The name must be at most 60 characters.',
      pickCharacter: 'Pick a bit',
      pickCharacterHint: 'Each bit comes with a ready-made description for its role. You can change the name and the description afterwards.',
      searchCharacters: 'Search by role, name or skill',
      noCharacters: 'No bit matches “{query}”.',
      changeCharacter: 'Change bit',
      chooseCharacter: 'Choose a bit',
      noCharacter: 'No character',
      noCharacterHint: 'This bit does not use a catalog character. Pick one to inherit its instructions and avatar.',
      catalogLoading: 'Loading bits…',
      catalogError: 'Could not load the bits.',
      continueWithout: 'Continue without a character',
      back: 'Back',
      otherGroup: 'Other',
      instructions: 'Description',
      instructionsHint: 'The bit context (persona and instructions), sent in every run. Edit freely (up to 20,000 characters).',
      instructionsPlaceholder: 'Describe the role, the way of working and the limits of this bit…',
      restoreDefault: 'Restore default description',
      instructionsTooLong: 'Instructions must be at most 20,000 characters.',
      noInstructions: 'No instructions yet.',
      orchestrator: 'Orchestrator',
      worker: 'Worker',
      isOrchestrator: 'Orchestrator',
      isOrchestratorHint: 'Orchestrators coordinate flows: they run as DSH agents and are the only bits allowed to lead a team. Workers receive one request and return a single response.',
      model: 'Model',
      modelHint: 'Model used by the runs. Orchestrators use DSH chat routes; workers may use the Claude Code subscription (claude_delegate) or a DSH route.',
      effort: 'Effort',
      effortHint: 'Reasoning effort applied to the model (varies per model).',
      modelGroupSubscription: 'Subscription (Claude Code)',
      modelGroupRoutes: 'DSH routes',
      modelsLoading: 'Loading models…',
      modelsError: 'Could not load the models.',
      modelMissing: 'Model “{id}” is not available in this profile.',
      modelRequired: 'Pick a model.',
      modelOrchestratorRequired: 'Orchestrators need a DSH chat route.',
      noModels: 'The host offers no models right now.',
      execute: 'Run',
      executeTitle: 'Run {name}',
      executeHint: 'An ad-hoc request: the bit receives the text and returns a single response.',
      runRequest: 'Request',
      runRequestPlaceholder: 'Describe the request with the needed context…',
      runReadOnly: 'Read only',
      runReadOnlyHint: 'No write access to the bit workspace: the worker only reads and answers.',
      runSubmit: 'Run',
      runRunning: 'Running…',
      runResponse: 'Response',
      runResponseEmpty: 'The response shows up here.',
      runClose: 'Close',
      runsInFlows: 'Executes in flows (Teams tab).',
      leadInTeams: 'Lead of: {names}',
      leadInTeamsNone: 'Not leading any team yet.',
      openTeamsTab: 'Open Teams',
      loading: 'Loading bits…',
      empty: 'No bits yet',
      emptyHint: 'Create a bit (Scout, Builder, Product Owner, …) to use it in a flow or run an ad-hoc request.',
      error: 'Could not load the bits.',
      retry: 'Retry',
      confirm: 'Confirm',
      deleted: 'Bit deleted.',
      deletedWorkspace: 'Bit deleted and workspace removed.',
      saved: 'Changes saved.',
      created: 'Bit created.',
      failed: 'Failed',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      working: 'Working…',
      close: 'Close',
    }

    /* ------------------------------------------------------------------ */
    /* Stylesheet (single <style> element rendered by the page)           */
    /* ------------------------------------------------------------------ */

    const STYLES = `
.dsh-bots-root { --dsh-bots-text: var(--dsw-alias-label-primary, rgba(20, 22, 30, .92)); --dsh-bots-text-2: var(--dsw-alias-label-secondary, rgba(20, 22, 30, .64)); --dsh-bots-text-3: var(--dsw-alias-label-tertiary, rgba(20, 22, 30, .5)); --dsh-bots-caption: var(--dsw-alias-label-caption, rgba(20, 22, 30, .4)); --dsh-bots-bg: var(--dsw-alias-bg-base, Canvas); --dsh-bots-bg-1: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, .05)); --dsh-bots-bg-2: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .09)); --dsh-bots-bg-3: var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, .12)); --dsh-bots-border-1: var(--dsw-alias-border-l1, rgba(127, 127, 127, .12)); --dsh-bots-border-2: var(--dsw-alias-border-l2, rgba(127, 127, 127, .18)); --dsh-bots-border-3: var(--dsw-alias-border-l3, rgba(127, 127, 127, .26)); --dsh-bots-border-4: var(--dsw-alias-border-l4, rgba(127, 127, 127, .36)); --dsh-bots-accent: var(--dsw-alias-state-business-primary, #3b82f6); --dsh-bots-ok: var(--dsw-alias-state-success-primary, #16a34a); --dsh-bots-bad: var(--dsw-alias-state-error-primary, #dc2626); --dsh-bots-warn: var(--dsw-alias-state-warn-primary, #d97706); --dsh-bots-hover: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .1)); --dsh-bots-active: var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, .16)); --dsh-bots-primary: var(--dsw-alias-button-primary-fill, #3b82f6); --dsh-bots-primary-hover: var(--dsw-alias-button-primary-hover, #2563eb); --dsh-bots-primary-text: var(--dsw-alias-label-primary-foreground, #fff); --dsh-bots-mask: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .45)); --dsh-bots-skeleton: var(--dsw-alias-bg-skeleton, rgba(127, 127, 127, .14)); --dsh-bots-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, .24)); --dsh-bots-radius: var(--dsw-radius-xl, 12px); --dsh-bots-radius-md: var(--dsw-radius-md, 8px); --dsh-bots-radius-sm: var(--dsw-radius-sm, 6px); --dsh-bots-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); --dsh-bots-ring: 0 0 0 2px var(--dsh-bots-accent); box-sizing: border-box; height: 100%; color: var(--dsh-bots-text); font-size: 14px; line-height: 22px; -webkit-font-smoothing: antialiased; }
.dsh-bots-page { box-sizing: border-box; height: 100%; overflow-y: auto; overflow-x: hidden; background: var(--dsh-bots-bg); color: var(--dsh-bots-text); font-size: 14px; line-height: 22px; -webkit-font-smoothing: antialiased; }
.dsh-bots-inner { box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; width: 100%; max-width: 1000px; margin: 0 auto; padding: 0 clamp(20px, 4vw, 48px) 48px; }
.dsh-bots-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 16px; padding-top: 28px; }
[data-platform="darwin"] .dsh-bots-head { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.dsh-bots-heading { min-width: 0; }
.dsh-bots-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
.dsh-bots-intro { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsh-bots-text-2); }
.dsh-bots-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.dsh-bots-body { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.dsh-bots-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; border: 0; border-radius: var(--dsh-bots-radius-md); background: transparent; color: var(--dsh-bots-text); font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer; }
.dsh-bots-button:disabled { cursor: not-allowed; opacity: .45; }
.dsh-bots-button:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); }
.dsh-bots-button-primary { background: var(--dsh-bots-primary); color: var(--dsh-bots-primary-text); }
.dsh-bots-button-primary:hover:not(:disabled) { background: var(--dsh-bots-primary-hover); }
.dsh-bots-button-outline { box-shadow: inset 0 0 0 1px var(--dsh-bots-border-3); }
.dsh-bots-button-outline:hover:not(:disabled) { background: var(--dsh-bots-hover); }
.dsh-bots-button-outline:active:not(:disabled) { background: var(--dsh-bots-active); }
.dsh-bots-button-ghost:hover:not(:disabled) { background: var(--dsh-bots-hover); }
.dsh-bots-button-ghost:active:not(:disabled) { background: var(--dsh-bots-active); }
.dsh-bots-button-danger { color: var(--dsh-bots-bad); }
.dsh-bots-button-danger:hover:not(:disabled) { background: var(--dsh-bots-hover); }
.dsh-bots-button-danger-solid { background: var(--dsh-bots-bad); color: var(--dsh-bots-primary-text); }
.dsh-bots-button-danger-solid:hover:not(:disabled) { background: var(--dsh-bots-bad); opacity: .88; }
.dsh-bots-button-sm { height: 28px; padding: 0 10px; border-radius: var(--dsh-bots-radius-sm); font-size: 12px; }
.dsh-bots-icon-button { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--dsh-bots-radius-md); background: transparent; color: var(--dsh-bots-text-2); cursor: pointer; }
.dsh-bots-icon-button:hover:not(:disabled) { background: var(--dsh-bots-hover); color: var(--dsh-bots-text); }
.dsh-bots-icon-button:active:not(:disabled) { background: var(--dsh-bots-active); }
.dsh-bots-icon-button:disabled { cursor: not-allowed; opacity: .45; }
.dsh-bots-icon-button:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); }
.dsh-bots-icon-button-sm { width: 28px; height: 28px; border-radius: var(--dsh-bots-radius-sm); }
.dsh-bots-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: currentColor; }
.dsh-bots-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; min-width: 0; }
.dsh-bots-card { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; min-width: 0; height: 100%; padding: 14px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius); background: var(--dsh-bots-bg-1); }
.dsh-bots-card:hover { border-color: var(--dsh-bots-border-3); }
.dsh-bots-card-head { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.dsh-bots-avatar { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; flex: none; border-radius: var(--dsh-bots-radius-md); font-size: 22px; line-height: 1; user-select: none; }
.dsh-bots-card-titles { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.dsh-bots-name-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.dsh-bots-name { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; line-height: 22px; }
.dsh-bots-badge { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border: 1px solid var(--dsh-bots-border-2); border-radius: 999px; background: var(--dsh-bots-bg-2); color: var(--dsh-bots-text-2); font-size: 11px; line-height: 18px; font-weight: 500; white-space: nowrap; }
.dsh-bots-badge-ok { color: var(--dsh-bots-ok); }
.dsh-bots-badge-bad { color: var(--dsh-bots-bad); }
.dsh-bots-badge-warn { color: var(--dsh-bots-warn); }
.dsh-bots-badge-info { color: var(--dsh-bots-accent); }
.dsh-bots-persona { margin: 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 13px; line-height: 19px; color: var(--dsh-bots-text-2); min-height: 19px; }
.dsh-bots-persona-empty { font-style: italic; color: var(--dsh-bots-text-3); }
.dsh-bots-meta { display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--dsh-bots-text-3); font-size: 12px; line-height: 18px; }
.dsh-bots-meta-label { flex: none; color: var(--dsh-bots-caption); }
.dsh-bots-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsh-bots-mono); color: var(--dsh-bots-text-3); }
.dsh-bots-warn { margin: 0; overflow-wrap: anywhere; color: var(--dsh-bots-warn); font-size: 12px; line-height: 18px; }
.dsh-bots-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--dsh-bots-border-1); }
.dsh-bots-actions-grow { flex: 1; }
.dsh-bots-skeleton { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius); background: var(--dsh-bots-bg-1); }
.dsh-bots-skeleton-head { display: flex; gap: 12px; align-items: center; }
.dsh-bots-skeleton-avatar { width: 44px; height: 44px; border-radius: var(--dsh-bots-radius-md); }
.dsh-bots-skeleton-col { display: flex; flex-direction: column; gap: 8px; flex: 1; }
.dsh-bots-skeleton-bar { height: 12px; border-radius: 6px; background: var(--dsh-bots-skeleton); animation: dsh-bots-pulse 1.6s ease-in-out infinite; }
.dsh-bots-skeleton-bar-wide { width: 70%; }
.dsh-bots-skeleton-bar-short { width: 40%; }
@keyframes dsh-bots-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .55; }
}
.dsh-bots-state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 44px 24px; border: 1px dashed var(--dsh-bots-border-3); border-radius: var(--dsh-bots-radius); background: var(--dsh-bots-bg-1); text-align: center; }
.dsh-bots-state-icon { color: var(--dsh-bots-text-3); }
.dsh-bots-state-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
.dsh-bots-state-text { margin: 0; max-width: 540px; font-size: 13px; line-height: 20px; color: var(--dsh-bots-text-2); overflow-wrap: anywhere; }
.dsh-bots-state-error .dsh-bots-state-title { color: var(--dsh-bots-bad); }
.dsh-bots-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-2); color: var(--dsh-bots-text-2); font-size: 13px; line-height: 20px; }
.dsh-bots-banner-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dsh-bots-visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.dsh-bots-overlay { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsh-bots-mask); }
.dsh-bots-dialog { box-sizing: border-box; display: flex; flex-direction: column; width: min(520px, 100%); max-height: min(760px, calc(100vh - 48px)); overflow: hidden; border-radius: var(--dsw-radius-panel, 12px); background: var(--dsh-bots-bg-2); color: var(--dsh-bots-text); box-shadow: var(--dsh-bots-shadow); }
.dsh-bots-dialog-wide { width: min(620px, 100%); }
.dsh-bots-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px 0; }
.dsh-bots-dialog-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 24px; overflow-wrap: anywhere; }
.dsh-bots-dialog-body { display: flex; flex-direction: column; gap: 14px; padding: 16px 20px; overflow-y: auto; min-height: 0; }
.dsh-bots-dialog-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 0 20px 18px; }
.dsh-bots-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-bots-field-grow { flex: 1; }
.dsh-bots-row { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.dsh-bots-label { font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsh-bots-text); }
.dsh-bots-hint { margin: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 18px; color: var(--dsh-bots-text-3); }
.dsh-bots-hint-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; }
.dsh-bots-error { margin: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 18px; color: var(--dsh-bots-bad); }
.dsh-bots-input, .dsh-bots-textarea, .dsh-bots-select { box-sizing: border-box; width: 100%; border: 1px solid var(--dsh-bots-border-4); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-3); color: var(--dsh-bots-text); font: inherit; font-size: 13px; line-height: 20px; padding: 6px 10px; outline: none; }
.dsh-bots-input, .dsh-bots-select { height: 34px; }
.dsh-bots-textarea { min-height: 168px; resize: vertical; }
.dsh-bots-input:focus, .dsh-bots-textarea:focus, .dsh-bots-select:focus { border-color: var(--dsh-bots-accent); box-shadow: inset 0 0 0 1px var(--dsh-bots-accent); }
.dsh-bots-input[aria-invalid="true"], .dsh-bots-textarea[aria-invalid="true"], .dsh-bots-select[aria-invalid="true"] { border-color: var(--dsh-bots-bad); box-shadow: none; }
.dsh-bots-palette { display: flex; flex-wrap: wrap; gap: 6px; }
.dsh-bots-emoji-chip { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 0; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); font-size: 18px; line-height: 1; cursor: pointer; }
.dsh-bots-emoji-chip:hover:not(:disabled) { background: var(--dsh-bots-hover); }
.dsh-bots-emoji-chip[aria-pressed="true"] { border-color: var(--dsh-bots-accent); box-shadow: inset 0 0 0 1px var(--dsh-bots-accent); }
.dsh-bots-emoji-chip:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); }
.dsh-bots-swatch { box-sizing: border-box; width: 26px; height: 26px; padding: 0; border: 2px solid transparent; border-radius: 50%; cursor: pointer; }
.dsh-bots-swatch:hover:not(:disabled) { opacity: .85; }
.dsh-bots-swatch[aria-pressed="true"] { outline: 2px solid var(--dsh-bots-text); outline-offset: 2px; }
.dsh-bots-swatch:focus-visible { outline: 2px solid var(--dsh-bots-accent); outline-offset: 2px; }
.dsh-bots-box { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); }
.dsh-bit-flow-note { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px dashed var(--dsh-bots-border-3); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); }
.dsh-bit-run-meta { font-family: var(--dsh-bots-mono); }
.dsh-bit-picker { display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow-y: auto; padding: 2px; }
.dsh-bit-picker-group { display: flex; flex-direction: column; gap: 4px; }
.dsh-bots-switch { display: inline-flex; align-items: center; gap: 8px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.dsh-bots-switch:disabled { cursor: not-allowed; opacity: .5; }
.dsh-bots-switch:focus-visible { outline: none; }
.dsh-bots-switch:focus-visible .dsh-bots-switch-track { box-shadow: var(--dsh-bots-ring); }
.dsh-bots-switch-track { position: relative; width: 36px; height: 20px; flex: none; border-radius: 999px; background: var(--dsh-bots-border-3); transition: background-color .15s ease; }
.dsh-bots-switch[aria-checked="true"] .dsh-bots-switch-track { background: var(--dsh-bots-primary); }
.dsh-bots-switch-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsh-bots-primary-text); box-shadow: 0 1px 2px rgba(0, 0, 0, .2); transition: transform .15s ease; }
.dsh-bots-switch[aria-checked="true"] .dsh-bots-switch-thumb { transform: translateX(16px); }
.dsh-bots-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 20px; color: var(--dsh-bots-text); cursor: pointer; }
.dsh-bots-check input { width: 16px; height: 16px; flex: none; margin: 2px 0 0; accent-color: var(--dsh-bots-bad); }
.dsh-bots-toast-wrap { position: fixed; right: 20px; bottom: 20px; z-index: 1300; max-width: min(420px, calc(100vw - 40px)); }
.dsh-bots-toast { display: flex; align-items: flex-start; gap: 8px; padding: 10px 14px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-2); color: var(--dsh-bots-text); box-shadow: var(--dsh-bots-shadow); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.dsh-bots-toast-icon { flex: none; margin-top: 2px; }
.dsh-bots-toast-ok .dsh-bots-toast-icon { color: var(--dsh-bots-ok); }
.dsh-bots-toast-error .dsh-bots-toast-icon { color: var(--dsh-bots-bad); }
.dsh-bots-dialog-xl { width: min(900px, 100%); max-height: min(840px, calc(100vh - 48px)); }
.dsh-bots-avatar-bit { overflow: hidden; padding: 0; }
.dsh-bots-avatar-bit img { display: block; width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; pointer-events: none; }
.dsh-bots-picker { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.dsh-bots-picker-search { position: sticky; top: -16px; z-index: 1; display: flex; flex-direction: column; gap: 6px; margin: -16px -20px 0; padding: 16px 20px 10px; background: var(--dsh-bots-bg-2); }
.dsh-bots-picker-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsh-bots-picker-heading { margin: 0; font-size: 12px; font-weight: 600; line-height: 18px; letter-spacing: .02em; text-transform: uppercase; color: var(--dsh-bots-text-3); }
.dsh-bots-bit-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(136px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; min-width: 0; }
.dsh-bots-bit-tile { box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; height: 100%; padding: 10px 8px 12px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); color: inherit; font: inherit; text-align: center; cursor: pointer; }
.dsh-bots-bit-tile:hover:not(:disabled) { background: var(--dsh-bots-hover); border-color: var(--dsh-bots-border-3); }
.dsh-bots-bit-tile[aria-pressed="true"] { border-color: var(--dsh-bots-accent); box-shadow: inset 0 0 0 1px var(--dsh-bots-accent); }
.dsh-bots-bit-tile:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); }
.dsh-bots-bit-name { font-size: 13px; font-weight: 600; line-height: 18px; overflow-wrap: anywhere; }
.dsh-bots-bit-summary { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: 11px; line-height: 15px; color: var(--dsh-bots-text-3); }
.dsh-bots-bit-hero { display: flex; align-items: flex-start; gap: 14px; padding: 12px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); }
.dsh-bots-bit-hero-text { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; flex: 1; min-width: 0; }
.dsh-bots-bit-hero-role { margin: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
.dsh-bots-bit-hero-summary { margin: 2px 0 8px; font-size: 13px; line-height: 19px; color: var(--dsh-bots-text-2); }
.dsh-bots-role { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 18px; color: var(--dsh-bots-text-3); }
.dsh-bots-link-button { padding: 0; border: 0; background: none; color: var(--dsh-bots-accent); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.dsh-bots-link-button:hover:not(:disabled) { text-decoration: underline; }
.dsh-bots-link-button:disabled { cursor: not-allowed; opacity: .5; }
.dsh-bots-link-button:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); border-radius: 4px; }
.dsh-bots-form-error { padding: 8px 10px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-2); }
@media (prefers-reduced-motion: reduce) {
  .dsh-bots-skeleton-bar { animation: none; }
  .dsh-bots-switch-track, .dsh-bots-switch-thumb { transition: none; }
}
@media (max-width: 640px) {
  .dsh-bots-inner { padding-left: 20px; padding-right: 20px; }
  .dsh-bots-overlay { padding: 12px; }
  .dsh-bots-row { flex-direction: column; }
}
`

    /* ------------------------------------------------------------------ */
    /* Icons (16x16 stroke SVGs drawn with currentColor)                  */
    /* ------------------------------------------------------------------ */

    /** Build a 16x16 stroke-icon component from SVG path data. */
    function pathsIcon(paths) {
      const children = paths.map(function (d, index) {
        return h('path', { key: index, d: d })
      })
      return function Icon(props) {
        const size = props && typeof props.size === 'number' ? props.size : 16
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        }, children)
      }
    }

    const RefreshIcon = pathsIcon([
      'M13.5 8a5.5 5.5 0 1 1-2.1-4.3',
      'M13.5 2.5V5h-2.6',
    ])
    const PlusIcon = pathsIcon(['M8 3v10', 'M3 8h10'])
    const EditIcon = pathsIcon([
      'M11.4 2.6l2 2L5.6 12.4l-3 .9.9-3z',
      'M10.2 3.8l2 2',
    ])
    const TrashIcon = pathsIcon([
      'M2.5 4.5h11',
      'M6 4.5V2.8h4v1.7',
      'M4.2 4.5l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2',
      'M6.8 7v3.4',
      'M9.2 7v3.4',
    ])
    const PlayIcon = pathsIcon(['M5.5 3.4l7 4.6-7 4.6z'])
    const CloseIcon = pathsIcon(['M4 4l8 8', 'M12 4l-8 8'])
    const CheckIcon = pathsIcon(['M3 8.5l3 3 7-7'])
    const WarningIcon = pathsIcon([
      'M8 2.4l6 11.2H2z',
      'M8 6.6v3.2',
      'M8 11.9h.01',
    ])
    /** Robot mark: the sidebar glyph, the empty state and the brand of the page. */
    function BotsGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      },
        h('rect', { key: 'head', x: 5, y: 8, width: 14, height: 11, rx: 3 }),
        h('path', { key: 'antenna', d: 'M12 8V4.5' }),
        h('circle', { key: 'tip', cx: 12, cy: 3.4, r: 1.2, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'eye-l', cx: 9.3, cy: 13, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'eye-r', cx: 14.7, cy: 13, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('path', { key: 'mouth', d: 'M9.2 16.2h5.6' }),
        h('path', { key: 'ear-l', d: 'M3 11.5v4' }),
        h('path', { key: 'ear-r', d: 'M21 11.5v4' })
      )
    }

    /* ------------------------------------------------------------------ */
    /* Small utilities                                                    */
    /* ------------------------------------------------------------------ */

    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function asString(value) {
      return typeof value === 'string' ? value : ''
    }

    /** Human message for an error or arbitrary thrown value. */
    function describeError(error) {
      if (error && typeof error.message === 'string' && error.message) return error.message
      if (typeof error === 'string' && error) return error
      return 'Unexpected error'
    }

    /** Stable t() even when the locale seat is missing (the slot still renders). */
    function fallbackT(key) {
      return Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key
    }

    /** Compress free text to a one-paragraph excerpt of at most `limit` characters. */
    function excerpt(text, limit) {
      const value = asString(text).replace(/\s+/g, ' ').trim()
      if (!value) return ''
      if (value.length <= limit) return value
      return value.slice(0, limit).replace(/\s+\S*$/, '') + '…'
    }

    /** Pick readable foreground for a bot-chosen background colour. */
    function contrastText(hex) {
      const match = /^#([0-9a-fA-F]{6})$/.exec(asString(hex))
      if (!match) return 'rgba(255, 255, 255, .96)'
      const value = parseInt(match[1], 16)
      const red = (value >> 16) & 255
      const green = (value >> 8) & 255
      const blue = value & 255
      const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
      return luminance > 0.66 ? 'rgba(18, 18, 22, .9)' : 'rgba(255, 255, 255, .96)'
    }

    /** `#rrggbb` + alpha as an `rgba()` string (fallback grey for bad input). */
    function hexAlpha(hex, alpha) {
      const match = /^#([0-9a-fA-F]{6})$/.exec(asString(hex))
      if (!match) return 'rgba(127, 127, 127, ' + alpha + ')'
      const value = parseInt(match[1], 16)
      return 'rgba(' + ((value >> 16) & 255) + ', ' + ((value >> 8) & 255) + ', ' + (value & 255) + ', ' + alpha + ')'
    }

    /** Lowercase, accent-free text for the picker search. */
    function foldText(value) {
      const text = asString(value).toLowerCase()
      return typeof text.normalize === 'function' ? text.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : text
    }

    /** Picker summary in the active language (pt or en). */
    function summaryOf(bit, lang) {
      if (!bit) return ''
      return lang === 'en' ? (bit.summary.en || bit.summary.pt) : (bit.summary.pt || bit.summary.en)
    }

    /** Group label in the active language. */
    function groupLabelOf(catalog, groupId, lang, t) {
      for (let index = 0; index < catalog.groups.length; index += 1) {
        const group = catalog.groups[index]
        if (group.id === groupId) return lang === 'en' ? group.label.en : group.label.pt
      }
      return t('otherGroup')
    }

    /** `usePanelInfo` fallback: the page only composes while its panel is selected. */
    function useAlwaysActivePanelInfo(selector) {
      return selector({ activePanelId: PANEL_ID })
    }

    /** Selector shared by the panel-info hook. */
    function selectPanelActive(info) {
      return !!info && info.activePanelId === PANEL_ID
    }

    /* ------------------------------------------------------------------ */
    /* API layer — relative paths, cookie auth is automatic               */
    /* ------------------------------------------------------------------ */

    /** Error carrying the Host's stable code when the route supplies one. */
    function apiError(code, message) {
      const error = new Error(message || code || 'Request failed')
      error.code = code || 'UNKNOWN'
      error.name = 'BotsApiError'
      return error
    }

    /** Perform one JSON request and unwrap the `{ ok, ... }` envelope. */
    async function fetchJson(path, body) {
      if (typeof fetch !== 'function') throw apiError('NO_FETCH', 'fetch is unavailable in this browser')
      const options = {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      let response
      try {
        response = await fetch(path, options)
      } catch (error) {
        throw apiError('NETWORK', describeError(error))
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!response.ok) {
        const detail = isObject(payload) && isObject(payload.error) ? asString(payload.error.message) : ''
        throw apiError('HTTP_' + response.status, detail || 'HTTP ' + response.status)
      }
      if (!isObject(payload)) throw apiError('BAD_RESPONSE', 'The server returned an unexpected response')
      if (payload.ok !== true) {
        const code = isObject(payload.error) ? asString(payload.error.code) : ''
        const message = isObject(payload.error) ? asString(payload.error.message) : ''
        throw apiError(code || 'REQUEST_FAILED', message || code)
      }
      return payload
    }

    /** Defensive bit projection (V5-CONTRACT.md §2). */
    function normalizeBit(raw) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      if (!id) return null
      return {
        id: id,
        name: asString(raw.name) || id,
        character: asString(raw.character) || null,
        emoji: asString(raw.emoji) || '🤖',
        color: /^#[0-9a-fA-F]{6}$/.test(asString(raw.color)) ? asString(raw.color) : COLOR_PALETTE[0],
        instructions: asString(raw.instructions),
        isOrchestrator: raw.isOrchestrator === true,
        model: asString(raw.model),
        effort: asString(raw.effort),
        workspaceDir: asString(raw.workspaceDir),
        createdAt: asString(raw.createdAt),
        updatedAt: asString(raw.updatedAt),
      }
    }

    /** Normalize `/api/bots.list` (accepts the `bots` alias of older hosts). */
    function normalizeBitsPayload(payload) {
      const source = Array.isArray(payload.bits) ? payload.bits : (Array.isArray(payload.bots) ? payload.bots : [])
      const bits = []
      const byId = {}
      source.forEach(function (raw) {
        const bit = normalizeBit(raw)
        if (bit && !byId[bit.id]) {
          byId[bit.id] = bit
          bits.push(bit)
        }
      })
      return { bits: bits, byId: byId }
    }

    /** Defensive model option projection (V5-CONTRACT.md §1). */
    function normalizeModelOption(raw) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      if (!id) return null
      const backend = asString(raw.backend) === 'dsh'
        ? 'dsh'
        : (asString(raw.backend) === 'claude-code' ? 'claude-code' : '')
      if (!backend) return null
      return {
        id: id,
        label: asString(raw.label) || id,
        group: asString(raw.group) || (backend === 'dsh' ? 'routes' : 'subscription'),
        backend: backend,
        provider: asString(raw.provider),
        model: asString(raw.model),
        alias: asString(raw.alias),
        efforts: stringList(raw.efforts).slice(0, 12),
        tools: raw.tools === true,
        // Orchestrators must run as DSH agents: only routes qualify by default.
        supportsOrchestrator: raw.supportsOrchestrator === undefined
          ? backend === 'dsh'
          : raw.supportsOrchestrator === true,
      }
    }

    /** Empty model-catalog state used before `/api/bots.models` answers. */
    function emptyModels(phase) {
      return { phase: phase, list: [], byId: {}, error: null }
    }

    /** Normalize `/api/bots.models`; malformed rows are dropped. */
    function normalizeModelsPayload(payload) {
      const list = []
      const byId = {}
      const source = isObject(payload) && Array.isArray(payload.models) ? payload.models : []
      source.forEach(function (raw) {
        const option = normalizeModelOption(raw)
        if (option && !byId[option.id]) {
          byId[option.id] = option
          list.push(option)
        }
      })
      return { list: list, byId: byId, error: isObject(payload) ? (asString(payload.error) || null) : null }
    }

    /** Empty catalog state used before `/api/bots.catalog` answers. */
    function emptyCatalog(phase) {
      return { phase: phase, groups: [], bits: [], byId: {}, error: null }
    }

    /** Normalize `/api/bots.catalog`; malformed rows are dropped. */
    function normalizeCatalogPayload(payload) {
      const groups = []
      const groupIds = {}
      if (Array.isArray(payload.groups)) {
        payload.groups.forEach(function (raw) {
          if (!isObject(raw)) return
          const id = asString(raw.id)
          if (!id || groupIds[id]) return
          groupIds[id] = true
          const label = isObject(raw.label) ? raw.label : {}
          groups.push({
            id: id,
            label: {
              pt: asString(label.pt) || asString(label.en) || id,
              en: asString(label.en) || asString(label.pt) || id,
            },
          })
        })
      }
      const bits = []
      const byId = {}
      if (Array.isArray(payload.bits)) {
        payload.bits.forEach(function (raw) {
          if (!isObject(raw)) return
          const id = asString(raw.id)
          if (!id || byId[id]) return
          const summary = isObject(raw.summary) ? raw.summary : {}
          const bit = {
            id: id,
            name: asString(raw.name) || id,
            group: asString(raw.group) || null,
            emoji: asString(raw.emoji) || '🤖',
            color: /^#[0-9a-fA-F]{6}$/.test(asString(raw.color)) ? asString(raw.color) : COLOR_PALETTE[0],
            summary: { pt: asString(summary.pt), en: asString(summary.en) },
            instructions: asString(raw.instructions),
            isOrchestrator: raw.isOrchestrator === true,
            model: asString(raw.model) || DEFAULT_WORKER_MODEL,
            effort: asString(raw.effort) || DEFAULT_WORKER_EFFORT,
            avatar: asString(raw.avatar) || '/api/bots.avatar?id=' + encodeURIComponent(id),
          }
          byId[id] = bit
          bits.push(bit)
        })
      }
      return { groups: groups, bits: bits, byId: byId, error: asString(payload.error) || null }
    }

    /** Normalize a create/update response (`bit`, with the `bot` alias). */
    function normalizeBitPayload(payload) {
      const bit = normalizeBit(payload.bit) || normalizeBit(payload.bot)
      if (!bit) throw apiError('BAD_RESPONSE', 'The server response is missing the bit record')
      return bit
    }

    const api = {
      async list() {
        return normalizeBitsPayload(await fetchJson('/api/bots.list'))
      },
      async catalog() {
        return normalizeCatalogPayload(await fetchJson('/api/bots.catalog'))
      },
      async models() {
        return normalizeModelsPayload(await fetchJson('/api/bots.models'))
      },
      async create(fields) {
        return normalizeBitPayload(await fetchJson('/api/bots.create', fields))
      },
      async update(id, patch) {
        return normalizeBitPayload(await fetchJson('/api/bots.update', { id: id, patch: patch }))
      },
      async remove(id, deleteWorkspace) {
        const payload = await fetchJson('/api/bots.delete', {
          id: id,
          deleteWorkspace: deleteWorkspace === true,
        })
        return {
          workspaceRemoved: payload.workspaceRemoved === true,
          workspaceDir: asString(payload.workspaceDir),
        }
      },
      /** Ad-hoc worker invocation: request → response (V5-CONTRACT.md §6.1/§7). */
      async run(id, request, readOnly) {
        const payload = await fetchJson('/api/bots.run', {
          id: id,
          request: request,
          readOnly: readOnly === true,
        })
        return {
          response: asString(payload.response),
          meta: isObject(payload.meta) ? payload.meta : {},
        }
      },
    }

    /* --------------------- model catalog helpers ------------------- */

    /** Model ids a bit family may pick: orchestrators only DSH routes. */
    function modelOptionsFor(models, isOrchestrator) {
      const list = models && Array.isArray(models.list) ? models.list : []
      return list.filter(function (option) {
        return isOrchestrator === true ? option.backend === 'dsh' : true
      })
    }

    /** Display label of a model id (falls back to the raw id). */
    function modelLabelOf(models, id) {
      if (!id) return ''
      const option = models && models.byId ? models.byId[id] : null
      return option ? option.label : id
    }

    /** Efforts a model offers (fallback list when it reports none). */
    function effortsForModel(models, modelId) {
      const option = modelId && models && models.byId ? models.byId[modelId] : null
      if (option && option.efforts.length > 0) return option.efforts
      return FALLBACK_EFFORTS
    }

    /** Default model id for a bit family. */
    function defaultModelFor(isOrchestrator) {
      return isOrchestrator === true ? DEFAULT_ORCHESTRATOR_MODEL : DEFAULT_WORKER_MODEL
    }

    /** Default effort for a bit family. */
    function defaultEffortFor(isOrchestrator) {
      return isOrchestrator === true ? DEFAULT_ORCHESTRATOR_EFFORT : DEFAULT_WORKER_EFFORT
    }

    /**
     * Snap a model id to a model usable by the bit family. The current value is
     * kept while it is offered (or the catalog is unknown, or it is a route the
     * profile no longer lists); an orchestrator holding a subscription model is
     * the only store-invalid combination and snaps to the family default.
     */
    function snapModel(models, isOrchestrator, current) {
      const options = modelOptionsFor(models, isOrchestrator)
      const ready = !!models && models.phase === 'ready'
      const wanted = asString(current)
      if (wanted) {
        if (!ready) return wanted
        if (options.some(function (option) { return option.id === wanted })) return wanted
        // An unknown id is kept: the provider may be offline but the route is
        // still the stored value the server validates. Subscription->orchestrator
        // is the one invalid combination (V5-CONTRACT.md §1/§2).
        if (isOrchestrator !== true || wanted.indexOf('subscription/') !== 0) return wanted
      }
      const preferred = defaultModelFor(isOrchestrator)
      if (options.some(function (option) { return option.id === preferred })) return preferred
      if (options.length > 0) return options[0].id
      return preferred
    }

    /** Snap an effort id to the efforts the chosen model offers. */
    function snapEffort(models, isOrchestrator, modelId, current) {
      const efforts = effortsForModel(models, modelId)
      const wanted = asString(current)
      if (wanted && efforts.indexOf(wanted) >= 0) return wanted
      const preferred = defaultEffortFor(isOrchestrator)
      if (efforts.indexOf(preferred) >= 0) return preferred
      return efforts[0] || ''
    }

    /** `<model label> · <effort>` shown on bit cards and read-only member rows. */
    function bitRouteText(bit, models) {
      if (!bit) return ''
      const model = bit.model ? modelLabelOf(models, bit.model) : ''
      return [model, bit.effort].filter(Boolean).join(' · ')
    }

    /* ------------------------------------------------------------------ */
    /* Form helpers                                                       */
    /* ------------------------------------------------------------------ */

    /** Default form values for create/edit. */
    function initialFormValues(bit) {
      if (bit) {
        return {
          name: bit.name,
          character: bit.character,
          emoji: bit.emoji,
          color: bit.color,
          instructions: bit.instructions,
          isOrchestrator: bit.isOrchestrator === true,
          model: bit.model || defaultModelFor(bit.isOrchestrator === true),
          effort: bit.effort || defaultEffortFor(bit.isOrchestrator === true),
        }
      }
      return {
        name: '',
        character: null,
        emoji: '🤖',
        color: COLOR_PALETTE[0],
        instructions: '',
        isOrchestrator: false,
        model: DEFAULT_WORKER_MODEL,
        effort: DEFAULT_WORKER_EFFORT,
      }
    }

    /** Client-side validation mirroring the record rules; returns `{ field: message }`. */
    function validateForm(values, t, models) {
      const errors = {}
      const name = asString(values.name).trim()
      if (!name) errors.name = t('nameRequired')
      else if (name.length > MAX_NAME) errors.name = t('nameTooLong')
      if (asString(values.instructions).length > MAX_INSTRUCTIONS) errors.instructions = t('instructionsTooLong')
      const orchestrator = values.isOrchestrator === true
      const modelId = asString(values.model).trim()
      if (!modelId) {
        errors.model = orchestrator ? t('modelOrchestratorRequired') : t('modelRequired')
      } else if (orchestrator) {
        // The store rejects an orchestrator with a subscription model; routes are
        // `<provider>/<modelId>` (V5-CONTRACT.md §1/§2).
        const option = models && models.byId ? models.byId[modelId] : null
        if (modelId.indexOf('subscription/') === 0 || (option && option.backend !== 'dsh')) {
          errors.model = t('modelOrchestratorRequired')
        }
      }
      return errors
    }

    function hasKeys(object) {
      return Object.keys(object).length > 0
    }

    /**
     * Payload shared by create and update for the editable fields. A chosen
     * catalog bit supplies the emoji and the accent colour; a bit without a
     * character keeps its own.
     */
    function formPayload(values, bit) {
      const payload = {
        name: asString(values.name).trim(),
        // The record contract requires 1..8 characters; empty falls back to the default.
        emoji: bit ? bit.emoji : (asString(values.emoji).trim() || '🤖'),
        color: bit ? bit.color : asString(values.color),
        instructions: asString(values.instructions),
        isOrchestrator: values.isOrchestrator === true,
        model: asString(values.model).trim(),
        effort: asString(values.effort).trim(),
      }
      if (bit) payload.character = bit.id
      return payload
    }

    /* ------------------------------------------------------------------ */
    /* UI primitives (host look, no Harness imports)                      */
    /* ------------------------------------------------------------------ */

    /** Host-style button with our plugin classes. */
    function Button(props) {
      const className = [
        'dsh-bots-button',
        props.variant ? 'dsh-bots-button-' + props.variant : '',
        props.size === 'sm' ? 'dsh-bots-button-sm' : '',
        props.className || '',
      ].filter(Boolean).join(' ')
      return h('button', {
        type: 'button',
        className: className,
        disabled: props.disabled === true,
        onClick: props.onClick,
        title: props.title,
        'aria-label': props.label,
        'aria-busy': props.busy === true ? 'true' : undefined,
      }, props.icon || null, props.children)
    }

    /** Square icon-only button with a required accessible label. */
    function IconButton(props) {
      const className = ['dsh-bots-icon-button', props.className || ''].filter(Boolean).join(' ')
      return h('button', {
        type: 'button',
        className: className,
        disabled: props.disabled === true,
        onClick: props.onClick,
        title: props.label,
        'aria-label': props.label,
      }, props.children)
    }

    /** Label + control + hint/error column used by the form dialog. */
    function Field(props) {
      return h('div', { className: 'dsh-bots-field' + (props.grow ? ' dsh-bots-field-grow' : '') },
        h('label', { className: 'dsh-bots-label', htmlFor: props.htmlFor }, props.label),
        props.children,
        props.error ? h('p', { className: 'dsh-bots-error', role: 'alert' }, props.error) : null,
        props.hint ? h('p', { className: 'dsh-bots-hint' }, props.hint) : null
      )
    }

    /** Checkbox with wrapping label. */
    function Checkbox(props) {
      return h('label', { className: 'dsh-bots-check' },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.checked) },
        }),
        h('span', null, props.label)
      )
    }

    /** Switch exposing `role="switch"` and `aria-checked`. */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        className: 'dsh-bots-switch',
        disabled: props.disabled === true,
        onClick: function () { if (typeof props.onChange === 'function') props.onChange(!props.checked) },
      },
        h('span', { className: 'dsh-bots-switch-track', 'aria-hidden': 'true' },
          h('span', { className: 'dsh-bots-switch-thumb' })),
        h('span', null, props.label)
      )
    }

    /** Small labelled badge with a status dot. */
    function Badge(props) {
      const tone = props.tone ? ' dsh-bots-badge-' + props.tone : ''
      return h('span', { className: 'dsh-bots-badge' + tone, title: props.title || undefined },
        props.dot === false ? null : h('span', { className: 'dsh-bots-dot', 'aria-hidden': 'true' }),
        props.label
      )
    }

    /** Every focusable element inside a dialog, in tab order. */
    function focusablesIn(node) {
      if (!node || typeof node.querySelectorAll !== 'function') return []
      const selector = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      const nodes = node.querySelectorAll(selector)
      const visible = []
      for (let index = 0; index < nodes.length; index += 1) {
        const candidate = nodes[index]
        if (typeof candidate.getClientRects === 'function' && candidate.getClientRects().length > 0) visible.push(candidate)
      }
      return visible
    }

    /**
     * Accessible modal: role/aria-modal, Escape and backdrop close, focus moves
     * into the dialog on open, Tab is trapped, and the close control is exposed.
     */
    function Modal(props) {
      const t = props.t || fallbackT
      const dialogRef = React.useRef(null)
      const closeRef = React.useRef(null)
      const titleId = React.useId()
      closeRef.current = typeof props.onClose === 'function' ? props.onClose : null

      React.useEffect(function () {
        const node = dialogRef.current
        const previousFocus = document.activeElement
        const preferred = props.initialFocusRef && props.initialFocusRef.current
        const target = preferred || (node ? focusablesIn(node)[0] : null)
        if (target && typeof target.focus === 'function') {
          try { target.focus() } catch (error) { /* focus is best effort */ }
        }
        function onKeyDown(event) {
          if (event.key === 'Escape' || event.key === 'Esc') {
            event.preventDefault()
            event.stopPropagation()
            if (closeRef.current) closeRef.current()
            return
          }
          if (event.key !== 'Tab' || !node) return
          const candidates = focusablesIn(node)
          if (candidates.length === 0) {
            event.preventDefault()
            return
          }
          const first = candidates[0]
          const last = candidates[candidates.length - 1]
          const active = document.activeElement
          if (!node.contains(active)) {
            // Focus escaped the dialog (e.g. a click on plain text); pull it back.
            event.preventDefault()
            if (event.shiftKey) last.focus()
            else first.focus()
          } else if (event.shiftKey && active === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function () {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previousFocus && typeof previousFocus.focus === 'function') {
            try { previousFocus.focus() } catch (error) { /* restore is best effort */ }
          }
        }
        // The dialog is mounted per open; focus setup runs once.
      }, [])

      function onOverlayMouseDown(event) {
        if (event.target !== event.currentTarget) return
        if (closeRef.current) closeRef.current()
      }

      return h('div', { className: 'dsh-bots-overlay', onMouseDown: onOverlayMouseDown },
        h('div', {
          className: 'dsh-bots-dialog' + (props.size === 'xl' ? ' dsh-bots-dialog-xl' : (props.wide ? ' dsh-bots-dialog-wide' : '')),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': titleId,
          ref: dialogRef,
        },
          h('div', { className: 'dsh-bots-dialog-head' },
            h('h2', { className: 'dsh-bots-dialog-title', id: titleId }, props.title),
            h(IconButton, {
              label: t('close'),
              disabled: props.dismissDisabled === true,
              onClick: function () { if (closeRef.current) closeRef.current() },
            }, h(CloseIcon, { size: 15 }))
          ),
          h('div', { className: 'dsh-bots-dialog-body' }, props.children),
          props.footer ? h('div', { className: 'dsh-bots-dialog-footer' }, props.footer) : null
        )
      )
    }

    /** Single auto-dismiss toast (4 s) announced politely or assertively. */
    function Toast(props) {
      const onDoneRef = React.useRef(null)
      onDoneRef.current = props.onDone
      React.useEffect(function () {
        const timer = setTimeout(function () {
          if (typeof onDoneRef.current === 'function') onDoneRef.current()
        }, 4000)
        return function () { clearTimeout(timer) }
      }, [props.toastKey])
      const tone = props.tone === 'error' ? 'error' : 'ok'
      return h('div', {
        className: 'dsh-bots-toast-wrap',
        role: tone === 'error' ? 'alert' : 'status',
        'aria-live': tone === 'error' ? 'assertive' : 'polite',
      },
        h('div', { className: 'dsh-bots-toast dsh-bots-toast-' + tone },
          h('span', { className: 'dsh-bots-toast-icon', 'aria-hidden': 'true' },
            tone === 'error' ? h(WarningIcon, { size: 15 }) : h(CheckIcon, { size: 15 })),
          h('span', { className: 'dsh-bots-toast-text' }, props.text)
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Bit card                                                           */
    /* ------------------------------------------------------------------ */

    /** Card of one bit definition: avatar, family badge, model route and actions. */
    function BitCard(props) {
      const t = props.t
      const bit = props.bit
      const models = props.models || emptyModels('idle')
      const busy = props.busy === bit.id
      const catalog = props.catalog
      const catalogBit = bit.character && catalog && catalog.byId[bit.character] ? catalog.byId[bit.character] : null
      const avatarBit = catalogBit || {
        id: bit.id, name: bit.name, color: bit.color, emoji: bit.emoji, avatar: '',
        summary: { pt: '', en: '' }, group: null,
      }
      const persona = excerpt(bit.instructions, 240)
      const leadTeams = Array.isArray(props.leadTeams) ? props.leadTeams : []
      const route = bitRouteText(bit, models)

      const editButton = h(Button, {
        variant: 'outline',
        size: 'sm',
        disabled: busy,
        onClick: function () { props.onEdit(bit) },
      }, h(EditIcon, { size: 14 }), t('edit'))

      const runButton = bit.isOrchestrator === true
        ? null
        : h(Button, {
          variant: 'primary',
          size: 'sm',
          disabled: busy,
          onClick: function () { props.onRun(bit) },
        }, h(PlayIcon, { size: 14 }), t('execute'))

      const deleteButton = h(Button, {
        variant: 'ghost',
        size: 'sm',
        className: 'dsh-bots-button-danger',
        disabled: busy,
        onClick: function () { props.onDelete(bit) },
      }, h(TrashIcon, { size: 14 }), t('delete'))

      return h('li', { className: 'dsh-bots-card', 'data-bit-id': bit.id },
        h('div', { className: 'dsh-bots-card-head' },
          h(BitAvatar, { bit: avatarBit, size: 52, emoji: bit.emoji, color: bit.color }),
          h('div', { className: 'dsh-bots-card-titles' },
            h('div', { className: 'dsh-bots-name-row' },
              h('h3', { className: 'dsh-bots-name', title: bit.name }, bit.name),
              h(Badge, {
                label: bit.isOrchestrator === true ? t('orchestrator') : t('worker'),
                tone: bit.isOrchestrator === true ? 'info' : 'neutral',
              })
            ),
            catalogBit
              ? h('p', { className: 'dsh-bots-role', title: summaryOf(catalogBit, props.lang) || undefined },
                catalogBit.name + ' · ' + groupLabelOf(catalog, catalogBit.group, props.lang, t))
              : h('p', { className: 'dsh-bots-role' }, t('noCharacter')),
            route
              ? h('div', { className: 'dsh-bots-meta dsh-bit-route' },
                h('span', { className: 'dsh-bots-meta-label' }, t('model')),
                h('span', { title: route }, route))
              : null
          )
        ),
        h('p', {
          className: 'dsh-bots-persona' + (persona ? '' : ' dsh-bots-persona-empty'),
          title: persona || undefined,
        }, persona || t('noInstructions')),
        bit.isOrchestrator === true
          ? h('div', { className: 'dsh-bit-flow-note' },
            h('p', { className: 'dsh-bots-hint' }, t('runsInFlows')),
            leadTeams.length > 0
              ? h('p', { className: 'dsh-bots-hint' },
                tf(t, 'leadInTeams', { names: leadTeams.map(function (team) { return team.name }).join(', ') }))
              : h('p', { className: 'dsh-bots-hint' }, t('leadInTeamsNone')),
            typeof props.onOpenTeams === 'function'
              ? h('button', { type: 'button', className: 'dsh-bots-link-button', onClick: props.onOpenTeams }, t('openTeamsTab'))
              : null)
          : null,
        h('div', { className: 'dsh-bots-actions' },
          runButton,
          editButton,
          h('span', { className: 'dsh-bots-actions-grow' }),
          deleteButton
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Run dialog (ad-hoc worker invocation)                              */
    /* ------------------------------------------------------------------ */

    /**
     * "Executar": request textarea, read-only toggle (default on), busy state
     * and the response/error panel (V5-CONTRACT.md §6.1/§8).
     */
    function RunBitDialog(props) {
      const t = props.t
      const bit = props.bit
      const models = props.models || emptyModels('idle')
      const inputRef = React.useRef(null)
      const [request, setRequest] = React.useState('')
      const [readOnly, setReadOnly] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState(null)
      const blocked = busy || request.trim() === ''

      async function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (blocked) return
        setBusy(true)
        setError(null)
        setResult(null)
        try {
          const data = await props.onRun(bit, request.trim(), readOnly)
          setResult(data)
        } catch (reason) {
          setError(requestErrorText(reason, t))
        } finally {
          setBusy(false)
        }
      }

      const meta = result && isObject(result.meta) ? result.meta : null
      const metaText = meta
        ? [
          asString(meta.backend),
          asString(meta.model),
          asString(meta.effort),
          typeof meta.durationMs === 'number' ? (meta.durationMs / 1000).toFixed(1) + 's' : '',
        ].filter(Boolean).join(' · ')
        : ''

      const footer = [
        h('button', { key: 'close', type: 'button', className: 'dsh-bots-button dsh-bots-button-outline', disabled: busy, onClick: props.onClose }, t('runClose')),
        h('button', {
          key: 'run',
          type: 'button',
          className: 'dsh-bots-button dsh-bots-button-primary',
          disabled: blocked,
          'aria-busy': busy ? 'true' : undefined,
          onClick: submit,
        }, h(PlayIcon, { size: 14 }), busy ? t('runRunning') : t('runSubmit')),
      ]

      return h(Modal, {
        t: t,
        title: tf(t, 'executeTitle', { name: bit.name }),
        wide: true,
        initialFocusRef: inputRef,
        onClose: props.onClose,
        dismissDisabled: busy,
        footer: footer,
      },
        h('p', { className: 'dsh-bots-hint' }, t('executeHint')),
        h(Field, { label: t('runRequest'), htmlFor: 'dsh-bots-run-request' },
          h('textarea', {
            id: 'dsh-bots-run-request',
            ref: inputRef,
            className: 'dsh-bots-textarea dsh-team-textarea-sm',
            value: request,
            maxLength: MAX_REQUEST,
            placeholder: t('runRequestPlaceholder'),
            disabled: busy,
            onChange: function (event) { setRequest(event.target.value); setError(null) },
          })),
        h('div', { className: 'dsh-bots-field' },
          h(Switch, {
            checked: readOnly,
            label: t('runReadOnly'),
            disabled: busy,
            onChange: function (value) { setReadOnly(value) },
          }),
          h('p', { className: 'dsh-bots-hint' }, t('runReadOnlyHint'))),
        error
          ? h('p', { className: 'dsh-bots-error dsh-bots-form-error', role: 'alert' }, error)
          : null,
        h(Field, { label: t('runResponse'), htmlFor: 'dsh-bots-run-response' },
          h('pre', {
            id: 'dsh-bots-run-response',
            className: 'dsh-team-preview' + (result && result.response ? '' : ' dsh-team-preview-empty'),
            'aria-live': 'polite',
            'aria-busy': busy ? 'true' : undefined,
          }, busy ? t('runRunning') : (result && result.response ? result.response : t('runResponseEmpty'))),
          metaText ? h('p', { className: 'dsh-bots-hint dsh-bit-run-meta' }, metaText) : null)
      )
    }

    /* ------------------------------------------------------------------ */
    /* Create / edit dialog                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Avatar of a bot or catalog bit: the bit illustration on a soft tint of its
     * accent colour, or the legacy emoji tile when there is no (loadable) bit.
     */
    function BitAvatar(props) {
      const size = typeof props.size === 'number' ? props.size : 44
      const bit = props.bit || null
      const src = bit ? bit.avatar : ''
      const [failedSrc, setFailedSrc] = React.useState('')
      const failed = !!src && failedSrc === src
      // A pseudo-bit (a catalog-less record) has no avatar image: fall back to the emoji tile.
      if (bit && src && !failed) {
        return h('span', {
          className: 'dsh-bots-avatar dsh-bots-avatar-bit',
          'aria-hidden': 'true',
          style: {
            width: size,
            height: size,
            background: 'radial-gradient(circle at 50% 62%, ' + hexAlpha(bit.color, 0.34) + ', ' + hexAlpha(bit.color, 0.1) + ' 72%)',
          },
        }, h('img', {
          src: src,
          alt: '',
          width: size,
          height: size,
          draggable: false,
          decoding: 'async',
          loading: props.eager ? 'eager' : 'lazy',
          onError: function () { setFailedSrc(src) },
        }))
      }
      const color = bit ? bit.color : (/^#[0-9a-fA-F]{6}$/.test(asString(props.color)) ? props.color : COLOR_PALETTE[0])
      return h('span', {
        className: 'dsh-bots-avatar',
        'aria-hidden': 'true',
        style: {
          width: size,
          height: size,
          fontSize: Math.round(size / 2),
          backgroundColor: color,
          color: contrastText(color),
        },
      }, bit ? bit.emoji : (asString(props.emoji) || '🤖'))
    }

    /** Searchable, grouped gallery of bit characters. */
    function CharacterPicker(props) {
      const t = props.t
      const lang = props.lang
      const catalog = props.catalog
      const [query, setQuery] = React.useState('')

      if (catalog.phase === 'loading') {
        return h('p', { className: 'dsh-bots-hint', role: 'status' }, t('catalogLoading'))
      }
      if (catalog.phase === 'error' || catalog.bits.length === 0) {
        return h('div', { className: 'dsh-bots-banner', role: 'alert' },
          h('span', { className: 'dsh-bots-banner-text' }, t('catalogError') + (catalog.error ? ' ' + catalog.error : '')),
          h(Button, { variant: 'outline', size: 'sm', onClick: props.onRetry }, t('retry')))
      }

      const needle = foldText(query.trim())
      function matches(bit) {
        if (!needle) return true
        return [bit.name, bit.id, bit.summary.pt, bit.summary.en].some(function (text) {
          return foldText(text).indexOf(needle) >= 0
        })
      }
      const known = {}
      catalog.groups.forEach(function (group) { known[group.id] = true })
      const sections = catalog.groups.map(function (group) {
        return { id: group.id, label: lang === 'en' ? group.label.en : group.label.pt, bits: [] }
      })
      const other = { id: '__other', label: t('otherGroup'), bits: [] }
      catalog.bits.forEach(function (bit) {
        if (!matches(bit)) return
        if (bit.group && known[bit.group]) {
          for (let index = 0; index < sections.length; index += 1) {
            if (sections[index].id === bit.group) sections[index].bits.push(bit)
          }
        } else {
          other.bits.push(bit)
        }
      })
      sections.push(other)
      const visible = sections.filter(function (section) { return section.bits.length > 0 })

      return h('div', { className: 'dsh-bots-picker' },
        h('div', { className: 'dsh-bots-picker-search' },
          h('p', { className: 'dsh-bots-hint' }, t('pickCharacterHint')),
          h('input', {
            ref: props.searchRef,
            className: 'dsh-bots-input',
            type: 'search',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: t('searchCharacters'),
            'aria-label': t('searchCharacters'),
            value: query,
            onChange: function (event) { setQuery(event.target.value) },
          })
        ),
        visible.length === 0
          ? h('p', { className: 'dsh-bots-hint', role: 'status' }, t('noCharacters', { query: query.trim() }).replace('{query}', query.trim()))
          : visible.map(function (section) {
            const headingId = 'dsh-bots-picker-' + section.id
            return h('section', { key: section.id, className: 'dsh-bots-picker-section', 'aria-labelledby': headingId },
              h('h3', { className: 'dsh-bots-picker-heading', id: headingId }, section.label),
              h('ul', { className: 'dsh-bots-bit-grid' }, section.bits.map(function (bit) {
                const summary = summaryOf(bit, lang)
                return h('li', { key: bit.id },
                  h('button', {
                    type: 'button',
                    className: 'dsh-bots-bit-tile',
                    'aria-pressed': props.selectedId === bit.id ? 'true' : 'false',
                    'aria-label': bit.name + (summary ? ' — ' + summary : ''),
                    title: summary || bit.name,
                    onClick: function () { props.onPick(bit) },
                  },
                    h(BitAvatar, { bit: bit, size: 72 }),
                    h('span', { className: 'dsh-bots-bit-name' }, bit.name),
                    summary ? h('span', { className: 'dsh-bots-bit-summary' }, summary) : null
                  ))
              }))
            )
          })
      )
    }

    /**
     * Create / edit dialog. Creating starts at the catalog picker; picking a bit
     * prefills the name, the description and the execution defaults (family,
     * model, effort), all editable. Editing opens the form directly, with
     * "Change bit" going back to the picker.
     */
    function FormDialog(props) {
      const t = props.t
      const lang = props.lang
      const catalog = props.catalog
      const models = props.models || emptyModels('idle')
      const editing = !!props.bot
      const onCancel = props.onCancel
      const onSubmit = props.onSubmit
      const nameRef = React.useRef(null)
      const searchRef = React.useRef(null)
      const firstStepRef = React.useRef(true)
      const [values, setValues] = React.useState(function () {
        return initialFormValues(props.bot)
      })
      const [step, setStep] = React.useState(editing ? 'form' : 'pick')
      const [errors, setErrors] = React.useState({})
      const [serverError, setServerError] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const bit = values.character && catalog.byId[values.character] ? catalog.byId[values.character] : null

      // The Modal focuses the first step; later step switches move focus here.
      React.useEffect(function () {
        if (firstStepRef.current) {
          firstStepRef.current = false
          return
        }
        const target = step === 'pick' ? searchRef.current : nameRef.current
        if (target && typeof target.focus === 'function') {
          try { target.focus() } catch (error) { /* focus is best effort */ }
        }
      }, [step])

      function patchValues(patch) {
        setValues(function (previous) {
          const next = {}
          Object.keys(previous).forEach(function (key) { next[key] = previous[key] })
          Object.keys(patch).forEach(function (key) { next[key] = patch[key] })
          return next
        })
      }

      /** Pick a catalog bit; name/description/family/model follow it unless customized. */
      function pickCharacter(next) {
        setValues(function (previous) {
          const previousBit = previous.character ? catalog.byId[previous.character] || null : null
          const updated = {}
          Object.keys(previous).forEach(function (key) { updated[key] = previous[key] })
          updated.character = next.id
          const name = asString(previous.name).trim()
          if (!name || (previousBit && name === previousBit.name)) updated.name = next.name
          const instructions = asString(previous.instructions)
          if (!instructions.trim() || (previousBit && instructions === previousBit.instructions)) {
            updated.instructions = next.instructions
          }
          const orchestrator = next.isOrchestrator === true
          updated.isOrchestrator = orchestrator
          const model = snapModel(models, orchestrator, next.model)
          updated.model = model
          updated.effort = snapEffort(models, orchestrator, model, next.effort)
          return updated
        })
        setErrors({})
        setStep('form')
      }

      /** Switching family snaps an incompatible model to the family default. */
      function changeOrchestrator(checked) {
        setValues(function (previous) {
          const next = Object.assign({}, previous, { isOrchestrator: checked === true })
          const familyChanged = (previous.isOrchestrator === true) !== next.isOrchestrator
          const model = snapModel(models, next.isOrchestrator, previous.model)
          next.model = model
          next.effort = familyChanged
            ? snapEffort(models, next.isOrchestrator, model, '')
            : snapEffort(models, next.isOrchestrator, model, previous.effort)
          return next
        })
        setErrors({})
      }

      function changeModel(modelId) {
        setValues(function (previous) {
          const next = Object.assign({}, previous, { model: modelId })
          next.effort = snapEffort(models, previous.isOrchestrator === true, modelId, previous.effort)
          return next
        })
        setErrors({})
      }

      function requestClose() {
        if (saving) return
        if (step === 'pick' && (editing || values.character)) {
          setStep('form')
          return
        }
        if (typeof onCancel === 'function') onCancel()
      }

      function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (saving) return
        const nextErrors = validateForm(values, t, models)
        setErrors(nextErrors)
        if (hasKeys(nextErrors)) {
          if (nextErrors.name && nameRef.current && typeof nameRef.current.focus === 'function') nameRef.current.focus()
          return
        }
        setSaving(true)
        setServerError(null)
        let result
        try {
          result = onSubmit(formPayload(values, bit))
        } catch (error) {
          setSaving(false)
          setServerError(describeError(error))
          return
        }
        Promise.resolve(result).catch(function (error) {
          setSaving(false)
          setServerError(describeError(error))
        })
      }

      if (step === 'pick') {
        const canGoBack = editing || !!values.character
        const pickFooter = [
          h(Button, {
            key: 'cancel',
            variant: 'outline',
            onClick: canGoBack ? function () { setStep('form') } : onCancel,
          }, canGoBack ? t('back') : t('cancel')),
        ]
        if (!canGoBack && catalog.phase === 'error') {
          pickFooter.push(h(Button, {
            key: 'without',
            variant: 'primary',
            onClick: function () { setStep('form') },
          }, t('continueWithout')))
        }
        return h(Modal, {
          t: t,
          title: t('pickCharacter'),
          size: 'xl',
          initialFocusRef: searchRef,
          onClose: requestClose,
          footer: pickFooter,
        },
          h(CharacterPicker, {
            t: t,
            lang: lang,
            catalog: catalog,
            selectedId: values.character,
            searchRef: searchRef,
            onPick: pickCharacter,
            onRetry: props.onRetryCatalog,
          })
        )
      }

      // Model options: the family filter plus the current value when the profile
      // no longer lists it (legacy data or a provider that is offline).
      const familyOptions = modelOptionsFor(models, values.isOrchestrator === true)
      const currentModel = asString(values.model)
      const unknownModel = currentModel !== '' && !familyOptions.some(function (option) { return option.id === currentModel })
      const groups = [
        { id: 'subscription', label: t('modelGroupSubscription'), options: familyOptions.filter(function (option) { return option.group !== 'routes' }) },
        { id: 'routes', label: t('modelGroupRoutes'), options: familyOptions.filter(function (option) { return option.group === 'routes' }) },
      ].filter(function (group) { return group.options.length > 0 })
      const modelOptions = []
      groups.forEach(function (group) {
        modelOptions.push(h('optgroup', { key: group.id, label: group.label },
          group.options.map(function (option) {
            return h('option', { key: option.id, value: option.id }, option.label)
          })))
      })
      if (unknownModel) {
        modelOptions.push(h('option', { key: 'unknown', value: currentModel }, tf(t, 'modelMissing', { id: currentModel })))
      }
      let modelHint = t('modelHint')
      if (models.phase === 'loading' || models.phase === 'idle') modelHint = t('modelsLoading')
      else if (models.phase === 'error') modelHint = t('modelsError')
      else if (models.list.length === 0) modelHint = t('noModels')

      // Efforts offered by the chosen model (current legacy value stays visible).
      let effortOptions = effortsForModel(models, currentModel)
      if (values.effort && effortOptions.indexOf(values.effort) < 0) effortOptions = effortOptions.concat([values.effort])

      const footer = [
        h(Button, {
          key: 'cancel',
          variant: 'outline',
          disabled: saving,
          onClick: requestClose,
        }, t('cancel')),
        h(Button, {
          key: 'save',
          variant: 'primary',
          busy: saving,
          disabled: saving,
          onClick: submit,
        }, saving ? t('saving') : (editing ? t('save') : t('create'))),
      ]

      const customized = !!bit && values.instructions !== bit.instructions

      return h(Modal, {
        t: t,
        title: editing ? t('editBot') : t('newBot'),
        wide: true,
        initialFocusRef: nameRef,
        onClose: requestClose,
        dismissDisabled: saving,
        footer: footer,
      },
        h('div', { className: 'dsh-bots-bit-hero' },
          h(BitAvatar, { bit: bit, size: 88, emoji: values.emoji, color: values.color, eager: true }),
          h('div', { className: 'dsh-bots-bit-hero-text' },
            h('p', { className: 'dsh-bots-bit-hero-role' }, bit ? bit.name : t('noCharacter')),
            bit ? h('p', { className: 'dsh-bots-hint' }, groupLabelOf(catalog, bit.group, lang, t)) : null,
            h('p', { className: 'dsh-bots-bit-hero-summary' }, bit ? summaryOf(bit, lang) : t('noCharacterHint')),
            h(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: saving,
              onClick: function () { setStep('pick') },
            }, bit ? t('changeCharacter') : t('chooseCharacter'))
          )
        ),
        h(Field, {
          label: t('name'),
          htmlFor: 'dsh-bots-name-input',
          error: errors.name,
        },
          h('input', {
            id: 'dsh-bots-name-input',
            ref: nameRef,
            className: 'dsh-bots-input',
            type: 'text',
            autoComplete: 'off',
            maxLength: MAX_NAME,
            placeholder: bit ? bit.name : t('namePlaceholder'),
            value: values.name,
            'aria-invalid': errors.name ? 'true' : 'false',
            disabled: saving,
            onChange: function (event) { patchValues({ name: event.target.value }) },
          })
        ),
        h(Field, {
          label: t('instructions'),
          htmlFor: 'dsh-bots-instructions-input',
          error: errors.instructions,
        },
          h('textarea', {
            id: 'dsh-bots-instructions-input',
            className: 'dsh-bots-textarea',
            rows: 10,
            maxLength: MAX_INSTRUCTIONS,
            placeholder: t('instructionsPlaceholder'),
            value: values.instructions,
            'aria-invalid': errors.instructions ? 'true' : 'false',
            disabled: saving,
            onChange: function (event) { patchValues({ instructions: event.target.value }) },
          }),
          h('div', { className: 'dsh-bots-hint-row' },
            h('p', { className: 'dsh-bots-hint' }, t('instructionsHint')),
            h('p', { className: 'dsh-bots-hint' }, values.instructions.length + ' / ' + MAX_INSTRUCTIONS)
          ),
          customized
            ? h('div', null, h('button', {
              type: 'button',
              className: 'dsh-bots-link-button',
              disabled: saving,
              onClick: function () { patchValues({ instructions: bit.instructions }) },
            }, t('restoreDefault')))
            : null
        ),
        h('div', { className: 'dsh-bots-box' },
          h('div', { className: 'dsh-bots-label' }, t('isOrchestrator')),
          h(Switch, {
            checked: values.isOrchestrator === true,
            label: values.isOrchestrator === true ? t('orchestrator') : t('worker'),
            disabled: saving,
            onChange: changeOrchestrator,
          }),
          h('p', { className: 'dsh-bots-hint' }, t('isOrchestratorHint'))),
        h('div', { className: 'dsh-bots-row' },
          h(Field, {
            label: t('model'),
            htmlFor: 'dsh-bots-model-input',
            grow: true,
            error: errors.model,
            hint: modelHint,
          },
            h('select', {
              id: 'dsh-bots-model-input',
              className: 'dsh-bots-select',
              value: currentModel,
              disabled: saving || models.phase === 'loading',
              'aria-invalid': errors.model ? 'true' : 'false',
              onChange: function (event) { changeModel(event.target.value) },
            },
              currentModel === '' ? h('option', { value: '' }, '—') : null,
              modelOptions)
          ),
          h(Field, {
            label: t('effort'),
            htmlFor: 'dsh-bots-effort-input',
            hint: values.isOrchestrator === true ? t('effortHint') : null,
          },
            h('select', {
              id: 'dsh-bots-effort-input',
              className: 'dsh-bots-select',
              style: { minWidth: 112 },
              value: values.effort,
              disabled: saving,
              onChange: function (event) { patchValues({ effort: event.target.value }) },
            },
              effortOptions.map(function (effort) {
                return h('option', { key: effort, value: effort }, effort)
              })))
        ),
        serverError ? h('p', { className: 'dsh-bots-error dsh-bots-form-error', role: 'alert' }, serverError) : null
      )
    }

    /* ------------------------------------------------------------------ */
    /* Confirm dialog (delete bit)                                        */
    /* ------------------------------------------------------------------ */

    function ConfirmDialog(props) {
      const t = props.t
      const cancelRef = React.useRef(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const destructive = props.destructive === true

      function requestCancel() {
        if (busy) return
        if (typeof props.onCancel === 'function') props.onCancel()
      }

      function confirm() {
        if (busy) return
        setBusy(true)
        setError(null)
        let result
        try {
          result = props.onConfirm()
        } catch (reason) {
          setBusy(false)
          setError(describeError(reason))
          return
        }
        Promise.resolve(result).catch(function (reason) {
          setBusy(false)
          setError(describeError(reason))
        })
      }

      const footer = [
        h('button', {
          key: 'cancel',
          type: 'button',
          ref: cancelRef,
          className: 'dsh-bots-button dsh-bots-button-outline',
          disabled: busy,
          onClick: requestCancel,
        }, t('cancel')),
        h('button', {
          key: 'confirm',
          type: 'button',
          className: 'dsh-bots-button ' + (destructive ? 'dsh-bots-button-danger-solid' : 'dsh-bots-button-primary'),
          disabled: busy,
          'aria-busy': busy ? 'true' : undefined,
          onClick: confirm,
        }, busy ? t('working') : (props.confirmLabel || t('confirm'))),
      ]

      return h(Modal, {
        t: t,
        title: props.title,
        initialFocusRef: cancelRef,
        onClose: requestCancel,
        dismissDisabled: busy,
        footer: footer,
      },
        h('p', { className: 'dsh-bots-state-text', style: { margin: 0 } }, props.description),
        props.children || null,
        error ? h('p', { className: 'dsh-bots-error', role: 'alert' }, error) : null
      )
    }

    /** Delete confirmation: names the bot and offers the workspace deletion opt-in. */
    function DeleteDialog(props) {
      const t = props.t
      const bot = props.bot
      const [deleteFiles, setDeleteFiles] = React.useState(false)
      return h(ConfirmDialog, {
        t: t,
        title: t('deleteTitle', { name: bot.name }),
        description: t('deleteBody'),
        confirmLabel: t('deleteConfirm'),
        destructive: true,
        onCancel: props.onCancel,
        onConfirm: function () { return props.onConfirm(deleteFiles) },
      },
        h(Checkbox, {
          checked: deleteFiles,
          label: t('deleteFiles'),
          onChange: function (checked) { setDeleteFiles(checked) },
        })
      )
    }

    /* ================================================================== */
    /* Teams of bits — list, templates and the visual flow editor         */
    /* ================================================================== */

    /** Teams copy (pt primary); merged into the bundle dictionaries. */
    const TEAM_PT = {
      tabsLabel: 'Seções',
      tabBots: 'Bits',
      tabTeams: 'Times',
      teamsSubtitle: 'Monte times de bits e desenhe o fluxo de trabalho entre eles: quem faz cada etapa, onde há decisão e para onde o trabalho volta.',
      newTeam: 'Novo time',
      importTeam: 'Importar',
      importTeamHint: 'Importar um time exportado (JSON)',
      exportTeam: 'Exportar',
      openFlow: 'Abrir fluxo',
      duplicateTeam: 'Duplicar',
      deleteTeam: 'Excluir',
      deleteTeamTitle: 'Excluir o time {name}?',
      deleteTeamBody: 'O time, os membros e o fluxo serão removidos. Os bits não são afetados.',
      teamsLoading: 'Carregando times…',
      teamsEmpty: 'Nenhum time ainda',
      teamsEmptyHint: 'Crie um time a partir de um modelo ou do zero e desenhe o fluxo arrastando bits para o quadro.',
      teamsError: 'Não foi possível carregar os times.',
      teamCreated: 'Time criado.',
      teamDeleted: 'Time excluído.',
      teamSaved: 'Fluxo salvo.',
      teamImported: 'Time importado.',
      teamDuplicated: 'Time duplicado.',
      importInvalid: 'O arquivo não contém um time válido.',
      copySuffix: '(cópia)',
      teamStats: '{members} membros · {steps} etapas · {edges} conexões',
      noDescription: 'Sem descrição.',
      startFrom: 'Começar de',
      blankTeam: 'Em branco',
      blankTeamHint: 'Só um nó de início; adicione bits e etapas.',
      templatesLoading: 'Carregando modelos…',
      teamName: 'Nome do time',
      teamNamePlaceholder: 'Ex.: Squad de pagamentos',
      teamNameRequired: 'Informe um nome para o time.',
      teamDescription: 'Descrição',
      teamDescriptionPlaceholder: 'Para que serve este time e como ele trabalha…',
      teamWorkspace: 'Repositório ou pasta',
      teamWorkspaceHint: 'Caminho absoluto onde o time trabalha (informativo).',
      workspaceInvalid: 'Use um caminho absoluto (ex.: /home/voce/projeto).',
      createTeam: 'Criar time',
      creating: 'Criando…',
      backToTeams: 'Voltar para os times',
      unsaved: 'Não salvo',
      allSaved: 'Salvo',
      undo: 'Desfazer (Ctrl+Z)',
      redo: 'Refazer (Ctrl+Shift+Z)',
      zoomIn: 'Aproximar',
      zoomOut: 'Afastar',
      zoomFit: 'Ajustar à tela',
      saveShortcut: 'Salvar (Ctrl+S)',
      discardTitle: 'Sair sem salvar?',
      discardBody: 'O fluxo tem alterações não salvas. Se sair agora, elas serão perdidas.',
      discard: 'Descartar e sair',
      palette: 'Elementos',
      paletteHint: 'Arraste para o quadro ou clique para adicionar no centro.',
      members: 'Membros',
      addMember: 'Adicionar bit',
      addMemberTitle: 'Adicionar um bit ao time',
      addMemberHint: 'O membro referencia um bit já criado na aba Bits. O bit define contexto, modelo, esforço e se é orquestrador.',
      addMemberPick: 'Bit',
      addMemberConfirm: 'Adicionar',
      addMemberNoBits: 'Nenhum bit para adicionar',
      addMemberNoBitsHint: 'Crie um bit na aba Bits e volte para adicioná-lo ao time.',
      membersEmpty: 'Nenhum membro ainda. Adicione bits para atribuir as etapas.',
      memberDragHint: 'Arraste um membro para o quadro para criar uma etapa dele.',
      memberBit: 'Bit',
      memberBitHint: 'O bit define contexto, modelo, esforço e a família (orquestrador ou worker).',
      memberBitMissing: 'Bit não encontrado ({id})',
      memberRoute: 'Modelo e esforço',
      memberReadOnlyHint: 'Modelo e esforço são editados no bit (aba Bits).',
      leadNotOrchestrator: 'O líder do time precisa ser um bit orquestrador.',
      noOrchestratorMembers: 'Nenhum membro é um bit orquestrador. Adicione um para escolher o líder.',
      leadInvalid: 'O líder atual não é um bit orquestrador. Escolha outro ou remova o líder.',
      nodeStart: 'Início',
      nodeStep: 'Etapa',
      nodeDecision: 'Decisão',
      nodePause: 'PAUSA',
      nodeEnd: 'Fim',
      nodeGroup: 'Fase',
      nodeNote: 'Nota',
      nodeStartDefault: 'Pedido',
      nodeStepDefault: 'Nova etapa',
      nodeDecisionDefault: 'Decidir',
      nodePauseDefault: 'Perguntar ao dev',
      nodeEndDefault: 'Fim',
      nodeGroupDefault: 'Nova fase',
      nodeNoteDefault: 'Anotação',
      untitled: 'Sem título',
      edgeFlow: 'Sequência',
      edgeLoop: 'Retorno / correção',
      edgeDelegate: 'Delegação (subagente)',
      teamProps: 'Time',
      nodeProps: 'Elemento',
      edgeProps: 'Conexão',
      memberProps: 'Membro',
      type: 'Tipo',
      label: 'Título',
      detail: 'Detalhes',
      detailHint: 'O que a etapa faz, skills a ler, critério de pronto.',
      member: 'Membro',
      noMember: 'Sem membro',
      color: 'Cor',
      outgoing: 'Saídas',
      incoming: 'Entradas',
      noConnections: 'Sem conexões. Arraste de uma das bolinhas do elemento até outro.',
      edgeLabel: 'Rótulo',
      edgeLabelPlaceholder: 'Ex.: sim, falhou, create-wt',
      edgeKind: 'Tipo de conexão',
      edgeFrom: 'De',
      edgeTo: 'Para',
      reverse: 'Inverter direção',
      duplicate: 'Duplicar',
      remove: 'Excluir',
      selectedCount: '{n} elementos selecionados',
      memberRole: 'Papel',
      memberRolePlaceholder: 'Resumo do papel no time',
      memberAccess: 'Acesso',
      accessRead: 'Somente leitura',
      accessWrite: 'Leitura e escrita',
      memberLaunches: 'Pode lançar',
      memberLaunchesNone: 'Não há outros membros.',
      memberSteps: '{n} etapa(s) no fluxo',
      removeMember: 'Remover do time',
      removeMemberTitle: 'Remover {name} do time?',
      removeMemberBody: '{n} etapa(s) usam este membro e ficarão sem membro.',
      shortcuts: 'Atalhos',
      shortcutPan: 'Arrastar o fundo ou rolar: mover o quadro',
      shortcutZoom: 'Ctrl + roda: zoom',
      shortcutMarquee: 'Shift + arrastar no fundo: selecionar área',
      shortcutConnect: 'Arrastar de uma bolinha: conectar',
      shortcutDelete: 'Delete: excluir seleção',
      shortcutDuplicate: 'Ctrl + D: duplicar',
      shortcutUndo: 'Ctrl + Z / Ctrl + Shift + Z: desfazer / refazer',
      shortcutGroup: 'Arrastar uma fase leva os elementos dentro dela (Alt: só a moldura)',
      canvasLabel: 'Quadro do fluxo. Use Delete para excluir a seleção e as setas para mover.',
      emptyCanvas: 'Arraste elementos ou membros para começar.',
      saveFailed: 'Não foi possível salvar',
      legendFlow: 'sequência',
      legendLoop: 'retorno',
      legendDelegate: 'delegação',
      togglePalette: 'Mostrar/ocultar elementos e membros',
      toggleInspector: 'Mostrar/ocultar propriedades',
      resize: 'Redimensionar',
      // v3: runnable teams and harness packs
      nodeTeam: 'Time',
      nodeTeamDefault: 'Outro time',
      edgeHandoff: 'Passagem para outro time',
      legendHandoff: 'passagem',
      teamNodeTarget: 'Time responsável',
      teamNodePick: 'Escolha um time',
      teamNodeNone: 'Nenhum time escolhido',
      teamNodeMissing: 'Time não encontrado',
      teamNodeNoOthers: 'Não há outros times. Crie outro time para passar etapas a ele.',
      teamNodeHint: 'Esta etapa é feita pelo líder do outro time.',
      leadLabel: 'Líder',
      leadNone: 'Sem líder',
      leadHint: 'Recebe os pedidos e orquestra o time. Só bits orquestradores podem ser líderes.',
      leadBadge: 'Líder',
      leadOf: 'Líder: {name}',
      makeLead: 'Tornar líder',
      memberSkills: 'Ler antes (skills)',
      memberSkillsHint: 'Skills que o membro lê antes de começar.',
      memberTeamRef: 'Representa o time',
      memberTeamRefNone: 'Nenhum (membro comum)',
      memberTeamRefHint: 'Delegar a este membro executa o líder do outro time.',
      memberMcp: 'Servidores MCP',
      memberMcpHint: 'Até 8 servidores do harness montados para o membro.',
      memberMcpNone: 'O harness não declara servidores MCP.',
      packSkillsNone: 'O harness não tem skills.',
      noPackHint: 'Escolha um harness nas propriedades do time para listar as skills e os servidores MCP.',
      packNeeded: 'Requer um harness no time.',
      packMissingHint: 'O harness “{id}” não foi encontrado. Importe-o de novo em Harness.',
      runSection: 'Execução',
      harnessLabel: 'Harness',
      harnessNone: 'Nenhum',
      harnessUnknown: '{id} (não encontrado)',
      packSummary: 'v{version} · {agents} presets · {skills} skills · {instructions} instruções · patches {applied}/{total}',
      packsLoading: 'Carregando harness…',
      packsError: 'Não foi possível carregar os harness.',
      routeMissing: 'O host ainda não oferece este recurso (atualize o plugin).',
      bindWorkspace: 'Toda sessão neste workspace é do time',
      bindWorkspaceHint: 'Sessões abertas dentro da pasta do time (inclusive worktrees) usam o líder deste time. Use em só um time por workspace.',
      bindWorkspaceNoDir: 'Defina o repositório ou pasta do time para vincular as sessões.',
      bindWorkspaceConflict: 'O time “{name}” também vincula este workspace.',
      rulesLabel: 'Regras extras',
      rulesHint: 'Acrescentadas depois das regras do harness em toda sessão do time.',
      rulesPlaceholder: 'Ex.: Responda sempre em português e cite o card AB…',
      teamSkills: 'Skills visíveis',
      teamSkillsHint: 'Nenhuma marcada = todas as skills do harness.',
      entriesLabel: 'Pedidos',
      entriesHint: 'Modelos do “Enviar pedido”. Use {n} para o número do card e {pedido} para o texto livre.',
      entriesEmpty: 'Nenhum modelo. O envio usa só o pedido livre.',
      entryLabelPlaceholder: 'Nome (ex.: Implementar card)',
      entryTemplatePlaceholder: 'Ex.: Implemente o card AB-{n}. {pedido}',
      addEntry: 'Adicionar pedido',
      removeEntry: 'Remover pedido',
      entryInvalid: 'Cada pedido precisa de nome e modelo.',
      sendRequest: 'Enviar pedido',
      sendRequestTitle: 'Enviar pedido para {name}',
      sendTemplate: 'Modelo',
      sendFree: 'Pedido livre',
      sendFreeHint: 'Escreva o pedido inteiro abaixo.',
      sendNumber: 'Número do card (AB)',
      sendNumberHint: 'Só os dígitos; “AB-123” e “AB#123” também valem.',
      sendNumberInvalid: 'Use só números (ex.: 123 ou AB-123).',
      sendNumberRequired: 'Este modelo precisa do número do card.',
      sendDetails: 'Detalhes/pedido',
      sendDetailsFree: 'Pedido',
      sendDetailsExtra: 'Detalhes (opcional, vão ao final)',
      sendDetailsPlaceholder: 'Descreva o que precisa ser feito…',
      sendPreview: 'Prévia',
      sendPreviewEmpty: 'O pedido aparece aqui.',
      sendSubmit: 'Iniciar fluxo',
      sendOpening: 'Iniciando…',
      sendStarted: 'Sessão iniciada',
      sendStartedHint: 'A sessão do time foi criada e o pedido já foi entregue ao líder.',
      sendOpenFailed: 'A sessão foi iniciada, mas esta página não conseguiu abri-la.',
      workspaceBound: 'Workspace vinculado',
      harnessBadge: 'Harness {id} v{version}',
      harnessBadgeNoVersion: 'Harness {id}',
      harnessButton: 'Harness',
      harnessButtonHint: 'Pacotes de harness (presets, skills, instruções e MCP) que os times podem usar',
      harnessTitle: 'Pacotes de harness',
      harnessIntro: 'Um harness é copiado de um repositório (AGENTS.md, .github/agents, skills, instruções, hooks e .mcp.json) para dentro dos Bits. Os times usam o pacote; o repositório não é alterado.',
      packsEmpty: 'Nenhum harness importado ainda.',
      packSource: 'Origem',
      packCounts: '{agents} presets · {skills} skills · {instructions} instruções · {mcp} MCP',
      packPatches: 'Patches: {applied}/{total} aplicados',
      packVersionUnknown: 'versão ?',
      createFromPack: 'Criar time deste harness',
      teamFromPackCreated: 'Time criado a partir do harness.',
      importHarness: 'Importar harness',
      importSourceDir: 'Pasta de origem',
      importSourceHint: 'Caminho absoluto do repositório que tem o harness.',
      importId: 'Id do pacote',
      importIdHint: 'Minúsculas, números, - e _. Reimportar o mesmo id substitui o pacote.',
      importIdInvalid: 'Use minúsculas, números, - e _ (ex.: dsc).',
      importName: 'Nome (opcional)',
      importSubmit: 'Importar',
      importing: 'Importando…',
      importDone: 'Harness importado',
      // v4: projects layer
      tabProjects: 'Projetos',
      projectsSubtitle: 'Organize os times por projeto: cada projeto reúne os times que trabalham juntos e um time compartilhado pode atender a mais de um projeto.',
      projectsLoading: 'Carregando projetos…',
      projectsError: 'Não foi possível carregar os projetos.',
      projectsEmpty: 'Nenhum projeto ainda',
      projectsEmptyHint: 'Crie um projeto para agrupar os times que trabalham juntos.',
      newProject: 'Novo projeto',
      projectCreated: 'Projeto criado.',
      projectSaved: 'Projeto salvo.',
      projectDeleted: 'Projeto excluído.',
      projectName: 'Nome do projeto',
      projectNamePlaceholder: 'Ex.: DSC',
      projectNameRequired: 'Informe um nome para o projeto.',
      projectDescription: 'Descrição',
      projectDescriptionPlaceholder: 'O que este projeto reúne e como os times trabalham nele…',
      projectEmoji: 'Emoji',
      projectColor: 'Cor',
      projectTeamsCount: '{n} time(s)',
      projectSharedCount: '{n} compartilhado(s)',
      backToProjects: 'Voltar para os projetos',
      openProject: 'Abrir',
      editProject: 'Editar projeto',
      deleteProject: 'Excluir projeto',
      deleteProjectTitle: 'Excluir o projeto {name}?',
      deleteProjectBody: 'O projeto será removido; os times não são excluídos, apenas desvinculados dele.',
      projectTeamsDetached: '{n} time(s) desvinculado(s).',
      noProjectTeams: 'Nenhum time neste projeto',
      noProjectTeamsHint: 'Adicione times que já existem ou crie um time novo dentro do projeto.',
      addExistingTeams: 'Adicionar times',
      addTeamsTitle: 'Adicionar times ao projeto',
      addTeamsHint: 'Marque os times que trabalham neste projeto. Times não compartilhados só podem estar em um projeto.',
      addTeamsConfirm: 'Aplicar',
      removeFromProject: 'Remover do projeto',
      removeFromProjectDone: 'Time removido do projeto.',
      projectTeamNotShared: 'Não compartilhado, já está no projeto',
      sharedTeam: 'Time compartilhado',
      sharedTeamHint: 'Permite usar este time em mais de um projeto.',
      sharedBadge: 'Compartilhado',
      sharedSingleProjectHint: 'Um time não compartilhado pode estar em um único projeto; mantivemos o primeiro.',
      teamProjects: 'Projetos do time',
      teamProjectsHint: 'Projeto em que o time trabalha. Marque “Time compartilhado” para usar em vários.',
      noProject: 'Nenhum projeto',
      projectUnknown: 'Projeto não encontrado',
      projectNewTeam: 'Novo time',
      createProject: 'Criar projeto',
      teamsInProjectsTitle: 'Nenhum time fora de projetos',
      teamsInProjectsHint: 'Times de projeto aparecem dentro do projeto. Abra Projetos para ver os {n} time(s) deste perfil, ou crie um time sem projeto para ele aparecer aqui.',
      teamsInProjectsNotice: '{n} time(s) de projeto aparecem na aba Projetos.',
      openProjectsTab: 'Ver projetos',
      teamMovedToProject: 'Time salvo: agora ele aparece na aba Projetos.',
      workspace: 'Workspace',
    }

    /** Teams copy (en fallback). */
    const TEAM_EN = {
      tabsLabel: 'Sections',
      tabBots: 'Bits',
      tabTeams: 'Teams',
      teamsSubtitle: 'Assemble teams of bits and draw how work flows between them: who does each step, where decisions happen and where work loops back.',
      newTeam: 'New team',
      importTeam: 'Import',
      importTeamHint: 'Import an exported team (JSON)',
      exportTeam: 'Export',
      openFlow: 'Open flow',
      duplicateTeam: 'Duplicate',
      deleteTeam: 'Delete',
      deleteTeamTitle: 'Delete team {name}?',
      deleteTeamBody: 'The team, its members and its flow will be removed. Bits are not affected.',
      teamsLoading: 'Loading teams…',
      teamsEmpty: 'No teams yet',
      teamsEmptyHint: 'Create a team from a template or from scratch and draw the flow by dragging bits onto the board.',
      teamsError: 'Could not load the teams.',
      teamCreated: 'Team created.',
      teamDeleted: 'Team deleted.',
      teamSaved: 'Flow saved.',
      teamImported: 'Team imported.',
      teamDuplicated: 'Team duplicated.',
      importInvalid: 'The file does not contain a valid team.',
      copySuffix: '(copy)',
      teamStats: '{members} members · {steps} steps · {edges} connections',
      noDescription: 'No description.',
      startFrom: 'Start from',
      blankTeam: 'Blank',
      blankTeamHint: 'Only a start node; add bits and steps.',
      templatesLoading: 'Loading templates…',
      teamName: 'Team name',
      teamNamePlaceholder: 'E.g. Payments squad',
      teamNameRequired: 'Enter a name for the team.',
      teamDescription: 'Description',
      teamDescriptionPlaceholder: 'What this team is for and how it works…',
      teamWorkspace: 'Repository or folder',
      teamWorkspaceHint: 'Absolute path where the team works (informational).',
      workspaceInvalid: 'Use an absolute path (e.g. /home/you/project).',
      createTeam: 'Create team',
      creating: 'Creating…',
      backToTeams: 'Back to teams',
      unsaved: 'Unsaved',
      allSaved: 'Saved',
      undo: 'Undo (Ctrl+Z)',
      redo: 'Redo (Ctrl+Shift+Z)',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      zoomFit: 'Fit to screen',
      saveShortcut: 'Save (Ctrl+S)',
      discardTitle: 'Leave without saving?',
      discardBody: 'The flow has unsaved changes. They will be lost if you leave now.',
      discard: 'Discard and leave',
      palette: 'Elements',
      paletteHint: 'Drag onto the board or click to add at the center.',
      members: 'Members',
      addMember: 'Add bit',
      addMemberTitle: 'Add a bit to the team',
      addMemberHint: 'The member references a bit already created on the Bits tab. The bit defines context, model, effort and whether it is an orchestrator.',
      addMemberPick: 'Bit',
      addMemberConfirm: 'Add',
      addMemberNoBits: 'No bits to add',
      addMemberNoBitsHint: 'Create a bit on the Bits tab and come back to add it to the team.',
      membersEmpty: 'No members yet. Add bits to assign the steps.',
      memberDragHint: 'Drag a member onto the board to create a step for it.',
      memberBit: 'Bit',
      memberBitHint: 'The bit defines context, model, effort and the family (orchestrator or worker).',
      memberBitMissing: 'Bit not found ({id})',
      memberRoute: 'Model and effort',
      memberReadOnlyHint: 'Model and effort are edited on the bit (Bits tab).',
      leadNotOrchestrator: 'The team lead must be an orchestrator bit.',
      noOrchestratorMembers: 'No member is an orchestrator bit. Add one to choose the lead.',
      leadInvalid: 'The current lead is not an orchestrator bit. Pick another one or clear the lead.',
      nodeStart: 'Start',
      nodeStep: 'Step',
      nodeDecision: 'Decision',
      nodePause: 'PAUSE',
      nodeEnd: 'End',
      nodeGroup: 'Phase',
      nodeNote: 'Note',
      nodeStartDefault: 'Request',
      nodeStepDefault: 'New step',
      nodeDecisionDefault: 'Decide',
      nodePauseDefault: 'Ask the dev',
      nodeEndDefault: 'End',
      nodeGroupDefault: 'New phase',
      nodeNoteDefault: 'Note',
      untitled: 'Untitled',
      edgeFlow: 'Sequence',
      edgeLoop: 'Loop back / fix',
      edgeDelegate: 'Delegation (subagent)',
      teamProps: 'Team',
      nodeProps: 'Element',
      edgeProps: 'Connection',
      memberProps: 'Member',
      type: 'Type',
      label: 'Title',
      detail: 'Details',
      detailHint: 'What the step does, skills to read, definition of done.',
      member: 'Member',
      noMember: 'No member',
      color: 'Color',
      outgoing: 'Outgoing',
      incoming: 'Incoming',
      noConnections: 'No connections. Drag from one of the element dots to another element.',
      edgeLabel: 'Label',
      edgeLabelPlaceholder: 'E.g. yes, failed, create-wt',
      edgeKind: 'Connection type',
      edgeFrom: 'From',
      edgeTo: 'To',
      reverse: 'Reverse direction',
      duplicate: 'Duplicate',
      remove: 'Delete',
      selectedCount: '{n} elements selected',
      memberRole: 'Role',
      memberRolePlaceholder: 'Summary of the role in the team',
      memberAccess: 'Access',
      accessRead: 'Read only',
      accessWrite: 'Read and write',
      memberLaunches: 'Can launch',
      memberLaunchesNone: 'There are no other members.',
      memberSteps: '{n} step(s) in the flow',
      removeMember: 'Remove from team',
      removeMemberTitle: 'Remove {name} from the team?',
      removeMemberBody: '{n} step(s) use this member and will be left without one.',
      shortcuts: 'Shortcuts',
      shortcutPan: 'Drag the background or scroll: move the board',
      shortcutZoom: 'Ctrl + wheel: zoom',
      shortcutMarquee: 'Shift + drag on the background: select an area',
      shortcutConnect: 'Drag from a dot: connect',
      shortcutDelete: 'Delete: remove the selection',
      shortcutDuplicate: 'Ctrl + D: duplicate',
      shortcutUndo: 'Ctrl + Z / Ctrl + Shift + Z: undo / redo',
      shortcutGroup: 'Dragging a phase carries the elements inside it (Alt: frame only)',
      canvasLabel: 'Flow board. Use Delete to remove the selection and the arrow keys to move it.',
      emptyCanvas: 'Drag elements or members here to start.',
      saveFailed: 'Could not save',
      legendFlow: 'sequence',
      legendLoop: 'loop back',
      legendDelegate: 'delegation',
      togglePalette: 'Show/hide elements and members',
      toggleInspector: 'Show/hide properties',
      resize: 'Resize',
      // v3: runnable teams and harness packs
      nodeTeam: 'Team',
      nodeTeamDefault: 'Another team',
      edgeHandoff: 'Handoff to another team',
      legendHandoff: 'handoff',
      teamNodeTarget: 'Responsible team',
      teamNodePick: 'Pick a team',
      teamNodeNone: 'No team chosen',
      teamNodeMissing: 'Team not found',
      teamNodeNoOthers: 'There are no other teams. Create another team to hand steps to it.',
      teamNodeHint: 'This step is handled by the other team’s lead.',
      leadLabel: 'Lead',
      leadNone: 'No lead',
      leadHint: 'Receives the requests and orchestrates the team. Only orchestrator bits can lead.',
      leadBadge: 'Lead',
      leadOf: 'Lead: {name}',
      makeLead: 'Make lead',
      memberSkills: 'Read first (skills)',
      memberSkillsHint: 'Skills the member reads before starting.',
      memberTeamRef: 'Stands for the team',
      memberTeamRefNone: 'None (regular member)',
      memberTeamRefHint: 'Delegating to this member runs the other team’s lead.',
      memberMcp: 'MCP servers',
      memberMcpHint: 'Up to 8 harness servers mounted for the member.',
      memberMcpNone: 'The harness declares no MCP servers.',
      packSkillsNone: 'The harness has no skills.',
      noPackHint: 'Pick a harness in the team properties to list its skills and MCP servers.',
      packNeeded: 'Requires a team harness.',
      packMissingHint: 'Harness “{id}” was not found. Import it again under Harness.',
      runSection: 'Running',
      harnessLabel: 'Harness',
      harnessNone: 'None',
      harnessUnknown: '{id} (not found)',
      packSummary: 'v{version} · {agents} presets · {skills} skills · {instructions} instructions · patches {applied}/{total}',
      packsLoading: 'Loading harness packs…',
      packsError: 'Could not load the harness packs.',
      routeMissing: 'The host does not offer this yet (update the plugin).',
      bindWorkspace: 'Every session in this workspace belongs to the team',
      bindWorkspaceHint: 'Sessions opened inside the team folder (worktrees included) use this team’s lead. Use it on one team per workspace only.',
      bindWorkspaceNoDir: 'Set the team repository or folder to bind its sessions.',
      bindWorkspaceConflict: 'Team “{name}” also binds this workspace.',
      rulesLabel: 'Extra rules',
      rulesHint: 'Appended after the harness rules in every team session.',
      rulesPlaceholder: 'E.g. Always answer in English and cite the AB card…',
      teamSkills: 'Visible skills',
      teamSkillsHint: 'None checked = every harness skill.',
      entriesLabel: 'Requests',
      entriesHint: 'Templates for “Send request”. Use {n} for the card number and {pedido} for the free text.',
      entriesEmpty: 'No templates. Sending uses the free request only.',
      entryLabelPlaceholder: 'Name (e.g. Implement card)',
      entryTemplatePlaceholder: 'E.g. Implement card AB-{n}. {pedido}',
      addEntry: 'Add request',
      removeEntry: 'Remove request',
      entryInvalid: 'Every request needs a name and a template.',
      sendRequest: 'Send request',
      sendRequestTitle: 'Send a request to {name}',
      sendTemplate: 'Template',
      sendFree: 'Free request',
      sendFreeHint: 'Write the whole request below.',
      sendNumber: 'Card number (AB)',
      sendNumberHint: 'Digits only; “AB-123” and “AB#123” work too.',
      sendNumberInvalid: 'Use digits only (e.g. 123 or AB-123).',
      sendNumberRequired: 'This template needs the card number.',
      sendDetails: 'Details/request',
      sendDetailsFree: 'Request',
      sendDetailsExtra: 'Details (optional, added at the end)',
      sendDetailsPlaceholder: 'Describe what needs to be done…',
      sendPreview: 'Preview',
      sendPreviewEmpty: 'The request shows up here.',
      sendSubmit: 'Start flow',
      sendOpening: 'Starting…',
      sendStarted: 'Session started',
      sendStartedHint: 'The team session was created and the request was already delivered to the lead.',
      sendOpenFailed: 'The session was started, but this page could not open it.',
      workspaceBound: 'Workspace bound',
      harnessBadge: 'Harness {id} v{version}',
      harnessBadgeNoVersion: 'Harness {id}',
      harnessButton: 'Harness',
      harnessButtonHint: 'Harness packs (presets, skills, instructions and MCP) the teams can use',
      harnessTitle: 'Harness packs',
      harnessIntro: 'A harness is copied from a repository (AGENTS.md, .github/agents, skills, instructions, hooks and .mcp.json) into Bits. Teams use the pack; the repository is not changed.',
      packsEmpty: 'No harness imported yet.',
      packSource: 'Source',
      packCounts: '{agents} presets · {skills} skills · {instructions} instructions · {mcp} MCP',
      packPatches: 'Patches: {applied}/{total} applied',
      packVersionUnknown: 'version ?',
      createFromPack: 'Create team from this harness',
      teamFromPackCreated: 'Team created from the harness.',
      importHarness: 'Import harness',
      importSourceDir: 'Source directory',
      importSourceHint: 'Absolute path of the repository that holds the harness.',
      importId: 'Pack id',
      importIdHint: 'Lowercase letters, digits, - and _. Importing the same id again replaces the pack.',
      importIdInvalid: 'Use lowercase letters, digits, - and _ (e.g. dsc).',
      importName: 'Name (optional)',
      importSubmit: 'Import',
      importing: 'Importing…',
      importDone: 'Harness imported',
      // v4: projects layer
      tabProjects: 'Projects',
      projectsSubtitle: 'Organize teams by project: each project gathers the teams that work together, and a shared team can serve more than one project.',
      projectsLoading: 'Loading projects…',
      projectsError: 'Could not load the projects.',
      projectsEmpty: 'No projects yet',
      projectsEmptyHint: 'Create a project to group the teams that work together.',
      newProject: 'New project',
      projectCreated: 'Project created.',
      projectSaved: 'Project saved.',
      projectDeleted: 'Project deleted.',
      projectName: 'Project name',
      projectNamePlaceholder: 'E.g. DSC',
      projectNameRequired: 'Enter a name for the project.',
      projectDescription: 'Description',
      projectDescriptionPlaceholder: 'What this project gathers and how the teams work on it…',
      projectEmoji: 'Emoji',
      projectColor: 'Color',
      projectTeamsCount: '{n} team(s)',
      projectSharedCount: '{n} shared',
      backToProjects: 'Back to projects',
      openProject: 'Open',
      editProject: 'Edit project',
      deleteProject: 'Delete project',
      deleteProjectTitle: 'Delete project {name}?',
      deleteProjectBody: 'The project is removed; the teams are not deleted, only detached from it.',
      projectTeamsDetached: '{n} team(s) detached.',
      noProjectTeams: 'No teams in this project',
      noProjectTeamsHint: 'Add teams that already exist or create a new team inside the project.',
      addExistingTeams: 'Add teams',
      addTeamsTitle: 'Add teams to the project',
      addTeamsHint: 'Check the teams that work on this project. Non-shared teams can belong to a single project.',
      addTeamsConfirm: 'Apply',
      removeFromProject: 'Remove from project',
      removeFromProjectDone: 'Team removed from the project.',
      projectTeamNotShared: 'Not shared, already in project',
      sharedTeam: 'Shared team',
      sharedTeamHint: 'Lets this team be used by more than one project.',
      sharedBadge: 'Shared',
      sharedSingleProjectHint: 'A non-shared team can belong to a single project; we kept the first one.',
      teamProjects: 'Team projects',
      teamProjectsHint: 'Project the team works on. Check “Shared team” to use it in several.',
      noProject: 'No project',
      projectUnknown: 'Project not found',
      projectNewTeam: 'New team',
      createProject: 'Create project',
      teamsInProjectsTitle: 'No teams outside projects',
      teamsInProjectsHint: 'Project teams are shown inside their project. Open Projects to see all {n} team(s) of this profile, or create a team without a project so it shows up here.',
      teamsInProjectsNotice: '{n} project team(s) are shown in the Projects tab.',
      openProjectsTab: 'View projects',
      teamMovedToProject: 'Team saved: it now appears in the Projects tab.',
      workspace: 'Workspace',
    }

    Object.assign(PT, TEAM_PT)
    Object.assign(EN, TEAM_EN)

    const TEAM_STYLES = `
.dsh-bots-tabrow { display: flex; align-items: center; gap: 12px; margin-top: -6px; }
.dsh-bots-tabs { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--dsh-bots-border-1); border-radius: 10px; background: var(--dsh-bots-bg-2); }
.dsh-bots-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 14px; border: 0; border-radius: 8px; background: transparent; color: var(--dsh-bots-text-2); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; }
.dsh-bots-tab:hover:not([aria-selected="true"]) { background: var(--dsh-bots-hover); color: var(--dsh-bots-text); }
.dsh-bots-tab[aria-selected="true"] { background: var(--dsh-bots-bg); color: var(--dsh-bots-text); font-weight: 500; box-shadow: 0 1px 2px rgba(0, 0, 0, .08), inset 0 0 0 1px var(--dsh-bots-border-2); }
.dsh-bots-tab:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); }
.dsh-team-thumb { display: block; width: 100%; height: 132px; border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg); border: 1px solid var(--dsh-bots-border-1); }
.dsh-team-thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--dsh-bots-text-3); font-size: 12px; }
.dsh-team-stack { display: flex; align-items: center; min-width: 0; }
.dsh-team-stack > .dsh-bots-avatar { margin-left: -8px; border-radius: 50%; box-shadow: 0 0 0 2px var(--dsh-bots-bg); }
.dsh-team-stack > .dsh-bots-avatar:first-child { margin-left: 0; }
.dsh-team-more { margin-left: 6px; font-size: 12px; color: var(--dsh-bots-text-3); white-space: nowrap; }
.dsh-team-open { cursor: pointer; }
.dsh-team-choices { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.dsh-team-choice { box-sizing: border-box; display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 10px 12px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-team-choice:hover { background: var(--dsh-bots-hover); }
.dsh-team-choice[aria-checked="true"] { border-color: var(--dsh-bots-accent); box-shadow: inset 0 0 0 1px var(--dsh-bots-accent); }
.dsh-team-choice:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); }
.dsh-team-choice-emoji { font-size: 20px; line-height: 24px; flex: none; width: 24px; text-align: center; }
.dsh-team-choice-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-team-choice-name { font-size: 13px; font-weight: 600; line-height: 20px; }
.dsh-team-choice-desc { font-size: 12px; line-height: 17px; color: var(--dsh-bots-text-3); }
.dsh-team-editor { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsh-bots-bg); color: var(--dsh-bots-text); font-size: 13px; line-height: 20px; -webkit-font-smoothing: antialiased; }
.dsh-team-bar { display: flex; align-items: center; gap: 6px; flex: none; min-width: 0; padding: 8px 12px; border-bottom: 1px solid var(--dsh-bots-border-2); background: var(--dsh-bots-bg); }
[data-platform="darwin"] .dsh-team-bar { padding-top: calc(8px + var(--dsh-frame-top-clearance, 0px)); }
.dsh-team-bar-title { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.dsh-team-bar-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 600; line-height: 22px; }
.dsh-team-bar-sep { width: 1px; height: 20px; margin: 0 4px; background: var(--dsh-bots-border-2); flex: none; }
.dsh-team-zoom { min-width: 44px; text-align: center; font-size: 12px; color: var(--dsh-bots-text-2); font-variant-numeric: tabular-nums; }
.dsh-team-body { display: flex; flex: 1; min-height: 0; }
.dsh-team-side { box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; width: 248px; flex: none; padding: 12px; overflow-y: auto; border-right: 1px solid var(--dsh-bots-border-2); background: var(--dsh-bots-bg-1); }
.dsh-team-inspector { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; width: 312px; flex: none; padding: 14px; overflow-y: auto; border-left: 1px solid var(--dsh-bots-border-2); background: var(--dsh-bots-bg-1); }
.dsh-team-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.dsh-team-section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0; font-size: 11px; font-weight: 600; line-height: 18px; letter-spacing: .05em; text-transform: uppercase; color: var(--dsh-bots-text-3); }
.dsh-team-palette { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dsh-team-palette-item { box-sizing: border-box; display: flex; align-items: center; gap: 7px; height: 32px; min-width: 0; padding: 0 8px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg); color: var(--dsh-bots-text); font: inherit; font-size: 12px; text-align: left; cursor: grab; }
.dsh-team-palette-item:hover { border-color: var(--dsh-bots-border-4); background: var(--dsh-bots-hover); }
.dsh-team-palette-item:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); }
.dsh-team-palette-item span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-team-type-icon { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; border-radius: 5px; color: var(--node-color); background: var(--node-tint); }
.dsh-team-members { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.dsh-team-member { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 6px; border: 1px solid transparent; border-radius: var(--dsh-bots-radius-md); background: transparent; color: inherit; font: inherit; text-align: left; cursor: grab; }
.dsh-team-member:hover { background: var(--dsh-bots-hover); }
.dsh-team-member[aria-pressed="true"] { border-color: var(--dsh-bots-accent); background: var(--dsh-bots-bg); }
.dsh-team-member:focus-visible { outline: none; box-shadow: var(--dsh-bots-ring); }
.dsh-team-member-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.dsh-team-member-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; line-height: 18px; }
.dsh-team-member-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 16px; color: var(--dsh-bots-text-3); }
.dsh-team-count { flex: none; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--dsh-bots-bg-3); color: var(--dsh-bots-text-2); font-size: 11px; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
.dsh-team-help { margin: 0; padding: 0 0 0 16px; font-size: 12px; line-height: 18px; color: var(--dsh-bots-text-3); }
.dsh-team-help li { margin: 2px 0; }
.dsh-team-kv { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; color: var(--dsh-bots-text-2); }
.dsh-team-conn { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.dsh-team-conn-item { box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 8px; border: 1px solid var(--dsh-bots-border-1); border-radius: var(--dsh-bots-radius-sm); background: var(--dsh-bots-bg); color: inherit; font: inherit; font-size: 12px; line-height: 18px; text-align: left; cursor: pointer; }
.dsh-team-conn-item:hover { background: var(--dsh-bots-hover); }
.dsh-team-conn-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-team-conn-label { flex: none; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsh-bots-text-3); }
.dsh-team-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-team-launches { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; padding: 6px 8px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg); }
.dsh-team-launches .dsh-bots-check input { accent-color: var(--dsh-bots-accent); }
.dsh-team-textarea-sm { min-height: 96px; }
.dsh-flow-canvas { position: relative; flex: 1; min-width: 0; overflow: hidden; outline: none; cursor: default; touch-action: none; user-select: none; -webkit-user-select: none; background-color: var(--dsh-bots-bg); background-image: radial-gradient(circle, var(--dsh-bots-border-3) 1px, transparent 1.3px); }
.dsh-flow-canvas.is-panning { cursor: grabbing; }
.dsh-flow-canvas.is-connecting, .dsh-flow-canvas.is-connecting * { cursor: crosshair !important; }
.dsh-flow-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
.dsh-flow-edges { position: absolute; overflow: visible; pointer-events: none; z-index: 1; }
.dsh-flow-edge-hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; cursor: pointer; }
.dsh-flow-edge { fill: none; stroke: var(--dsh-bots-text-3); stroke-width: 1.6; }
.dsh-flow-edge-loop { stroke: var(--dsh-bots-warn); stroke-dasharray: 7 5; }
.dsh-flow-edge-delegate { stroke: var(--dsh-bots-accent); stroke-dasharray: 1.5 5; stroke-linecap: round; stroke-width: 2; }
.dsh-flow-edge.is-selected { stroke: var(--dsh-bots-accent); stroke-width: 2.8; }
.dsh-flow-edge.is-related { stroke-width: 2.4; }
.dsh-flow-edge-temp { fill: none; stroke: var(--dsh-bots-accent); stroke-width: 2; stroke-dasharray: 5 4; }
.dsh-flow-arrow { fill: var(--dsh-bots-text-3); }
.dsh-flow-arrow-loop { fill: var(--dsh-bots-warn); }
.dsh-flow-arrow-delegate { fill: var(--dsh-bots-accent); }
.dsh-flow-arrow-selected { fill: var(--dsh-bots-accent); }
.dsh-flow-edge-label { position: absolute; z-index: 1; max-width: 180px; height: 18px; padding: 0 6px; overflow: hidden; transform: translate(-50%, -50%); border: 1px solid var(--dsh-bots-border-2); border-radius: 999px; background: var(--dsh-bots-bg); color: var(--dsh-bots-text-2); font-size: 10.5px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.dsh-flow-edge-label-loop { color: var(--dsh-bots-warn); }
.dsh-flow-edge-label-delegate { color: var(--dsh-bots-accent); }
.dsh-flow-edge-label.is-selected { z-index: 3; border-color: var(--dsh-bots-accent); color: var(--dsh-bots-accent); }
.dsh-flow-node { position: absolute; z-index: 2; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsh-bots-border-3); border-radius: 12px; background-color: var(--dsh-bots-bg); background-image: linear-gradient(var(--node-tint), var(--node-tint)); color: var(--dsh-bots-text); box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 4px 12px rgba(0, 0, 0, .05); cursor: grab; outline: none; }
.dsh-flow-node:hover { border-color: var(--dsh-bots-border-4); }
.dsh-flow-node:focus-visible { box-shadow: var(--dsh-bots-ring); }
.dsh-flow-node.is-selected { border-color: var(--dsh-bots-accent); box-shadow: 0 0 0 2px var(--dsh-bots-accent), 0 6px 16px rgba(0, 0, 0, .1); }
.dsh-flow-node.is-target { box-shadow: 0 0 0 3px var(--dsh-bots-ok); }
.dsh-flow-node.is-dimmed { opacity: .35; }
.dsh-flow-node-step { border-left: 4px solid var(--node-color); background-image: none; }
.dsh-flow-node-start, .dsh-flow-node-end { justify-content: center; border-color: var(--node-border); border-radius: 999px; }
.dsh-flow-node-decision { border-color: var(--node-border); border-radius: 6px 22px 6px 22px; }
.dsh-flow-node-pause { border: 1.5px dashed var(--node-color); }
.dsh-flow-node-note { flex-direction: column; align-items: stretch; gap: 4px; padding: 10px 12px; border-color: var(--node-border); border-radius: 4px; box-shadow: none; overflow: hidden; }
.dsh-flow-icon { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; flex: none; border-radius: 9px; color: var(--node-color); background: var(--node-tint); }
.dsh-flow-node-start .dsh-flow-icon, .dsh-flow-node-end .dsh-flow-icon { width: 24px; height: 24px; border-radius: 50%; }
.dsh-flow-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.dsh-flow-node-start .dsh-flow-text, .dsh-flow-node-end .dsh-flow-text { flex: 0 1 auto; }
.dsh-flow-kicker { font-size: 10px; font-weight: 600; line-height: 14px; letter-spacing: .06em; text-transform: uppercase; color: var(--node-color); }
.dsh-flow-label { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; line-height: 17px; }
.dsh-flow-label-empty { font-style: italic; font-weight: 400; color: var(--dsh-bots-text-3); }
.dsh-flow-meta { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 15px; color: var(--dsh-bots-text-3); }
.dsh-flow-note-title { font-size: 12px; font-weight: 600; line-height: 17px; color: var(--node-color); overflow-wrap: anywhere; }
.dsh-flow-note-text { flex: 1; min-height: 0; overflow: hidden; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 12px; line-height: 17px; color: var(--dsh-bots-text-2); }
.dsh-flow-avatar-empty { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex: none; border: 1px dashed var(--dsh-bots-border-4); border-radius: var(--dsh-bots-radius-md); color: var(--dsh-bots-text-3); font-size: 16px; }
.dsh-flow-handle { position: absolute; z-index: 4; box-sizing: border-box; width: 12px; height: 12px; border: 2px solid var(--dsh-bots-accent); border-radius: 50%; background: var(--dsh-bots-bg); opacity: 0; transition: opacity .12s ease, transform .12s ease; cursor: crosshair; }
.dsh-flow-handle:hover { transform: scale(1.35); }
.dsh-flow-node:hover .dsh-flow-handle, .dsh-flow-node.is-selected .dsh-flow-handle, .dsh-flow-canvas.is-connecting .dsh-flow-handle { opacity: 1; }
.dsh-flow-handle-top { left: 50%; top: -7px; margin-left: -6px; }
.dsh-flow-handle-right { top: 50%; right: -7px; margin-top: -6px; }
.dsh-flow-handle-bottom { left: 50%; bottom: -7px; margin-left: -6px; }
.dsh-flow-handle-left { top: 50%; left: -7px; margin-top: -6px; }
.dsh-flow-group { position: absolute; z-index: 0; box-sizing: border-box; border: 1.5px dashed var(--node-border); border-radius: 16px; background: var(--node-tint); pointer-events: none; }
.dsh-flow-group.is-selected { border-style: solid; border-color: var(--dsh-bots-accent); }
.dsh-flow-group.is-dimmed { opacity: .4; }
.dsh-flow-group-head { position: absolute; left: 0; top: 0; right: 0; box-sizing: border-box; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; overflow: hidden; border-radius: 16px 16px 0 0; color: var(--node-color); font-size: 13px; font-weight: 600; line-height: 18px; white-space: nowrap; text-overflow: ellipsis; pointer-events: auto; cursor: grab; outline: none; }
.dsh-flow-group-head:hover { background: var(--node-tint); }
.dsh-flow-group-title { overflow: hidden; text-overflow: ellipsis; }
.dsh-flow-resize { position: absolute; right: 2px; bottom: 2px; z-index: 4; width: 14px; height: 14px; border-bottom-right-radius: 12px; background: linear-gradient(135deg, transparent 52%, var(--node-border) 52%); pointer-events: auto; cursor: nwse-resize; }
.dsh-flow-marquee { position: absolute; z-index: 5; box-sizing: border-box; border: 1px solid var(--dsh-bots-accent); background: rgba(59, 130, 246, .08); pointer-events: none; }
.dsh-flow-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--dsh-bots-text-3); font-size: 13px; pointer-events: none; }
.dsh-flow-legend { position: absolute; left: 12px; bottom: 12px; z-index: 6; display: flex; align-items: center; gap: 14px; padding: 5px 10px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg); color: var(--dsh-bots-text-2); font-size: 11px; line-height: 16px; pointer-events: none; }
.dsh-flow-legend span { display: inline-flex; align-items: center; gap: 6px; }
.dsh-flow-edge-handoff { stroke: #9333ea; stroke-dasharray: 10 4; stroke-width: 1.8; }
.dsh-flow-arrow-handoff { fill: #9333ea; }
.dsh-flow-edge-label-handoff { color: #9333ea; }
.dsh-flow-node-team { border-color: var(--node-border); border-left: 4px solid var(--node-color); }
.dsh-flow-team-emoji { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; flex: none; border-radius: 10px; background: var(--node-tint); box-shadow: inset 0 0 0 1px var(--node-border); color: var(--node-color); font-size: 21px; line-height: 1; }
.dsh-flow-meta-empty { font-style: italic; }
.dsh-team-tag { display: inline-flex; align-items: center; flex: none; height: 16px; padding: 0 6px; border-radius: 999px; background: var(--dsh-bots-bg-3); color: var(--dsh-bots-accent); font-size: 10px; font-weight: 600; line-height: 16px; letter-spacing: .02em; white-space: nowrap; }
.dsh-team-member-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-team-member-ref { color: #0891b2; }
.dsh-team-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.dsh-team-badges .dsh-bots-badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.dsh-team-summary { margin: 0; overflow-wrap: anywhere; font-size: 12px; line-height: 18px; color: var(--dsh-bots-text-2); font-variant-numeric: tabular-nums; }
.dsh-team-lead-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-team-entries { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.dsh-team-entry { box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg); }
.dsh-team-entry-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dsh-team-entry-head .dsh-bots-input { flex: 1; min-width: 0; }
.dsh-team-entry .dsh-bots-textarea { min-height: 64px; font-family: var(--dsh-bots-mono); font-size: 12px; line-height: 18px; }
.dsh-team-choice-mono { font-family: var(--dsh-bots-mono); font-size: 11.5px; overflow-wrap: anywhere; }
.dsh-team-choice-emoji > svg { margin: 4px auto 0; color: var(--dsh-bots-text-2); }
.dsh-team-preview { box-sizing: border-box; margin: 0; min-height: 56px; max-height: 180px; overflow: auto; padding: 10px 12px; border: 1px dashed var(--dsh-bots-border-3); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); color: var(--dsh-bots-text); font-family: var(--dsh-bots-mono); font-size: 12px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-team-preview-empty { color: var(--dsh-bots-text-3); font-style: italic; }
.dsh-team-packs { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.dsh-team-pack { box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 12px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); }
.dsh-team-pack-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.dsh-team-pack-name { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; line-height: 20px; }
.dsh-team-pack-id { font-family: var(--dsh-bots-mono); }
.dsh-team-pack-skips { margin: 0; padding: 0 0 0 16px; font-size: 12px; line-height: 18px; color: var(--dsh-bots-warn); }
.dsh-team-pack-actions { display: flex; justify-content: flex-end; gap: 6px; }
.dsh-team-subhead { margin: 4px 0 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.dsh-team-okbox { margin: 0; padding: 8px 10px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); color: var(--dsh-bots-ok); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.dsh-project-head { display: flex; align-items: flex-start; gap: 10px; flex: 1; min-width: 0; }
.dsh-project-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-project-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dsh-project-name { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 20px; font-weight: 500; line-height: 28px; }
.dsh-project-desc { margin: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 20px; color: var(--dsh-bots-text-2); }
.dsh-project-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-project-picker { display: flex; flex-direction: column; gap: 2px; max-height: 340px; overflow-y: auto; padding: 6px 10px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); }
.dsh-project-picker .dsh-bots-check { padding: 4px 0; }
.dsh-project-picker-label { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-project-picker-note { color: var(--dsh-bots-text-3); font-size: 11.5px; line-height: 17px; overflow-wrap: anywhere; }
@media (max-width: 1100px) {
  .dsh-team-side { width: 208px; }
  .dsh-team-inspector { width: 268px; }
}
`

    /* -------------------------- constants -------------------------- */

    const NODE_TYPES = ['start', 'step', 'team', 'decision', 'pause', 'end', 'group', 'note']
    const EDGE_KINDS = ['flow', 'loop', 'delegate', 'handoff']
    const HANDOFF_COLOR = '#9333ea'
    const NODE_SIZE = {
      start: [184, 48],
      end: [184, 48],
      step: [236, 72],
      team: [236, 72],
      decision: [216, 60],
      pause: [216, 60],
      note: [232, 128],
      group: [360, 420],
    }
    const TYPE_COLOR = {
      start: '#16a34a',
      end: '#64748b',
      step: '#2563eb',
      team: '#0891b2',
      decision: '#d97706',
      pause: '#db2777',
      note: '#ca8a04',
      group: '#2563eb',
    }
    const TYPE_LABEL_KEY = {
      start: 'nodeStart',
      step: 'nodeStep',
      team: 'nodeTeam',
      decision: 'nodeDecision',
      pause: 'nodePause',
      end: 'nodeEnd',
      group: 'nodeGroup',
      note: 'nodeNote',
    }
    const TYPE_DEFAULT_KEY = {
      start: 'nodeStartDefault',
      step: 'nodeStepDefault',
      team: 'nodeTeamDefault',
      decision: 'nodeDecisionDefault',
      pause: 'nodePauseDefault',
      end: 'nodeEndDefault',
      group: 'nodeGroupDefault',
      note: 'nodeNoteDefault',
    }
    const EDGE_KIND_KEY = { flow: 'edgeFlow', loop: 'edgeLoop', delegate: 'edgeDelegate', handoff: 'edgeHandoff' }
    /** Field limits mirroring host/teams.js (CONTRACT.md §11.1). */
    const MAX_RULES = 40000
    const MAX_ENTRY = 20
    const MAX_ENTRY_LABEL = 60
    const MAX_ENTRY_TEMPLATE = 2000
    const MAX_MEMBER_MCP = 8
    const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
    const ABSOLUTE_PATH_PATTERN = /^(\/|[A-Za-z]:[\\/]|~\/)/
    const GROUP_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#ca8a04', '#ea580c', '#db2777', '#64748b']
    const GRID = 8
    const ZOOM_MIN = 0.15
    const ZOOM_MAX = 2
    const HISTORY_LIMIT = 120
    const READABLE_ZOOM = 0.62
    const PANELS_STORAGE_KEY = 'dsh-bits.flow-panels'
    const DND_TYPE = 'application/x-dsh-bits-flow'
    const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
    const MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
    const TEAM_EXPORT_FORMAT = 'dsh-bits-team'
    const TAB_STORAGE_KEY = 'dsh-bits.tab'
    /** Persisted project id shape and defaults (CONTRACT.md §12.1). */
    const PROJECT_ID_PATTERN = /^[0-9a-f]{10}$/
    const PROJECT_EMOJI = '📁'
    const PROJECT_COLOR = '#2563eb'

    /* --------------------------- icons ---------------------------- */

    const ArrowLeftIcon = pathsIcon(['M13 8H3', 'M7 4L3 8l4 4'])
    const UndoIcon = pathsIcon(['M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6', 'M5.5 4L3 6.5 5.5 9'])
    const RedoIcon = pathsIcon(['M13 6.5H6.5a3.5 3.5 0 0 0 0 7H10', 'M10.5 4L13 6.5 10.5 9'])
    const MinusIcon = pathsIcon(['M3 8h10'])
    const FitIcon = pathsIcon(['M2.5 6V2.5H6', 'M10 2.5h3.5V6', 'M13.5 10v3.5H10', 'M6 13.5H2.5V10'])
    const SaveIcon = pathsIcon(['M3 2.5h8l2.5 2.5v8.5h-11z', 'M5 2.5v3.5h5V2.5', 'M5 13.5V9.5h6v4'])
    const CopyIcon = pathsIcon(['M5.5 5.5h8v8h-8z', 'M10.5 5.5v-3h-8v8h3'])
    const DownloadIcon = pathsIcon(['M8 2.5v8', 'M4.5 7L8 10.5 11.5 7', 'M3 13.5h10'])
    const UploadIcon = pathsIcon(['M8 10.5v-8', 'M4.5 6L8 2.5 11.5 6', 'M3 13.5h10'])
    const FlowIcon = pathsIcon(['M2.5 3.5h4v3h-4z', 'M9.5 9.5h4v3h-4z', 'M6.5 5h2a1.5 1.5 0 0 1 1.5 1.5v3'])
    const SwapIcon = pathsIcon(['M3 5.5h10', 'M10.5 3L13 5.5 10.5 8', 'M13 10.5H3', 'M5.5 8L3 10.5 5.5 13'])
    const DiamondIcon = pathsIcon(['M8 2l6 6-6 6-6-6z'])
    const PersonIcon = pathsIcon(['M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M3 13.5a5 5 0 0 1 10 0'])
    const FrameIcon = pathsIcon(['M2.5 3.5h11v9h-11z', 'M2.5 6h11'])
    const NoteIcon = pathsIcon(['M3 2.5h7l3 3v8H3z', 'M10 2.5v3h3', 'M5.5 8.5h5', 'M5.5 11h3'])
    const StepIcon = pathsIcon(['M2.5 4.5h11v7h-11z', 'M5 8h6'])
    const PanelLeftIcon = pathsIcon(['M2.5 3h11v10h-11z', 'M6.5 3v10'])
    const PanelRightIcon = pathsIcon(['M2.5 3h11v10h-11z', 'M9.5 3v10'])
    const FlagIcon = pathsIcon(['M4 14V2.5', 'M4 3h8l-1.8 2.8L12 8.5H4'])
    const SendIcon = pathsIcon(['M13.8 2.2L7 9', 'M13.8 2.2L9.6 13.8 7 9 2.2 6.4z'])
    const PackageIcon = pathsIcon(['M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z', 'M2.5 4.8L8 7.8l5.5-3', 'M8 7.8v6.4'])
    const CrownIcon = pathsIcon(['M2.5 5l3 2.6L8 3.5l2.5 4.1 3-2.6-1.2 7H3.7z'])

    function TeamGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        focusable: 'false', style: { display: 'block', flex: 'none' },
      },
        h('circle', { key: 'a', cx: 6, cy: 5.5, r: 2.2 }),
        h('path', { key: 'b', d: 'M2 13a4 4 0 0 1 8 0' }),
        h('circle', { key: 'c', cx: 11.3, cy: 6.3, r: 1.7 }),
        h('path', { key: 'd', d: 'M11 10.2a3.3 3.3 0 0 1 3.4 2.8' })
      )
    }

    function ProjectsGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        focusable: 'false', style: { display: 'block', flex: 'none' },
      },
        h('path', { key: 'a', d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3H6l1.5 2H12.4A1.6 1.6 0 0 1 14 6.6v4.8A1.6 1.6 0 0 1 12.4 13H3.6A1.6 1.6 0 0 1 2 11.4z' }),
        h('path', { key: 'b', d: 'M5.4 9h5.2' })
      )
    }

    function typeIcon(type, size) {
      const s = size || 14
      if (type === 'start') return h(PlayIcon, { size: s })
      if (type === 'end') return h(FlagIcon, { size: s })
      if (type === 'decision') return h(DiamondIcon, { size: s })
      if (type === 'pause') return h(PersonIcon, { size: s })
      if (type === 'group') return h(FrameIcon, { size: s })
      if (type === 'note') return h(NoteIcon, { size: s })
      if (type === 'team') return h(TeamGlyph, { size: s })
      return h(StepIcon, { size: s })
    }

    /* --------------------------- helpers -------------------------- */

    /** Interpolate `{name}` placeholders whether or not the locale seat does. */
    function tf(t, key, vars) {
      let text = String(t(key, vars))
      Object.keys(vars || {}).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(vars[name]))
      })
      return text
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function snap(value) {
      return Math.round(value / GRID) * GRID
    }

    function finiteNumber(value, fallback) {
      return typeof value === 'number' && isFinite(value) ? value : fallback
    }

    function isHexColor(value) {
      return /^#[0-9a-fA-F]{6}$/.test(asString(value))
    }

    /** Whether `value` is a persisted project id (10 lowercase hex, §12.1). */
    function isProjectId(value) {
      return PROJECT_ID_PATTERN.test(asString(value))
    }

    function randomToken(length) {
      let out = ''
      while (out.length < length) out += Math.random().toString(36).slice(2)
      return out.slice(0, length)
    }

    /** Fresh id with `prefix` that is not a key of `taken`. */
    function freshId(prefix, taken) {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const candidate = prefix + randomToken(attempt < 50 ? 5 : 8)
        if (!taken[candidate]) return candidate
      }
      return prefix + Date.now().toString(36)
    }

    function indexBy(list) {
      const map = {}
      list.forEach(function (item) { map[item.id] = item })
      return map
    }

    /** Member id from a display name: lowercase ascii slug, unique in the team. */
    function memberSlug(name, members) {
      let base = foldText(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      if (!MEMBER_ID_PATTERN.test(base)) base = 'bit'
      const taken = indexBy(members)
      if (!taken[base]) return base
      for (let index = 2; index < 1000; index += 1) {
        if (!taken[base + '-' + index]) return base + '-' + index
      }
      return base + '-' + randomToken(4)
    }

    function nodeSize(node) {
      const fallback = NODE_SIZE[node.type] || NODE_SIZE.step
      if (node.type === 'group' || node.type === 'note') {
        return [finiteNumber(node.w, fallback[0]), finiteNumber(node.h, fallback[1])]
      }
      return fallback
    }

    function nodeRect(node) {
      const size = nodeSize(node)
      return { x: node.x, y: node.y, w: size[0], h: size[1] }
    }

    function rectContains(outer, inner) {
      return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
    }

    function rectsIntersect(a, b) {
      return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    }

    function flowBounds(nodes) {
      if (!nodes || nodes.length === 0) return null
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      nodes.forEach(function (node) {
        const rect = nodeRect(node)
        minX = Math.min(minX, rect.x)
        minY = Math.min(minY, rect.y)
        maxX = Math.max(maxX, rect.x + rect.w)
        maxY = Math.max(maxY, rect.y + rect.h)
      })
      return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
    }

    /** Node accent: the member's bit colour for steps, the node colour, or the type colour. */
    function nodeColor(node, membersById, catalog, bitsById) {
      if (node.type === 'step') {
        const member = node.memberId ? membersById[node.memberId] : null
        const bit = member ? memberBit(member, bitsById) : null
        const character = bitCharacter(bit, catalog)
        if (character) return character.color
        if (bit && isHexColor(bit.color)) return bit.color
        return member ? TYPE_COLOR.step : TYPE_COLOR.end
      }
      if (isHexColor(node.color)) return node.color
      return TYPE_COLOR[node.type] || TYPE_COLOR.step
    }

    /* ---------------------- record normalizers --------------------- */

    /** Non-empty, de-duplicated strings of an array (anything else → `[]`). */
    function stringList(value, limit) {
      const out = []
      if (!Array.isArray(value)) return out
      value.forEach(function (item) {
        if (typeof item !== 'string') return
        const text = item.trim()
        if (text && out.indexOf(text) < 0) out.push(text)
      })
      return typeof limit === 'number' ? out.slice(0, limit) : out
    }

    /** Bit record referenced by a team member, when the list knows it. */
    function memberBit(member, bitsById) {
      if (!member || !member.bitId) return null
      return bitsById && bitsById[member.bitId] ? bitsById[member.bitId] : null
    }

    /** Catalog character behind a bit record (avatar, group, summary). */
    function bitCharacter(bit, catalog) {
      if (!bit || !bit.character || !catalog || !catalog.byId) return null
      return catalog.byId[bit.character] || null
    }

    /** Avatar source for a bit record: its catalog character, else the record itself. */
    function avatarBitOf(bit, catalog) {
      if (!bit) return null
      const character = bitCharacter(bit, catalog)
      if (character) return character
      return {
        id: bit.id,
        name: bit.name,
        color: bit.color,
        emoji: bit.emoji,
        avatar: '',
        summary: { pt: '', en: '' },
        group: null,
      }
    }

    /** Display name of a member: the referenced bit name, else the stored bit id. */
    function memberName(member, bitsById) {
      if (!member) return ''
      const bit = memberBit(member, bitsById)
      if (bit) return bit.name
      return member.bitId || member.id
    }

    /** Whether a member's referenced bit is an orchestrator (only they can lead). */
    function memberIsOrchestrator(member, bitsById) {
      const bit = memberBit(member, bitsById)
      return !!bit && bit.isOrchestrator === true
    }

    /** `<model label> · <effort>` of a member bit (raw model id when unknown). */
    function memberRouteText(member, bitsById, models) {
      const bit = memberBit(member, bitsById)
      if (!bit) return ''
      const model = bit.model ? modelLabelOf(models, bit.model) : ''
      return [model, bit.effort].filter(Boolean).join(' · ')
    }

    /** Defensive v5 member projection: a reference to a bit (V5-CONTRACT.md §5.1). */
    function normalizeMember(raw) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      if (!MEMBER_ID_PATTERN.test(id)) return null
      return {
        id: id,
        bitId: asString(raw.bitId) || null,
        role: asString(raw.role),
        access: raw.access === 'read' ? 'read' : 'write',
        launches: Array.isArray(raw.launches) ? raw.launches.filter(function (value) { return typeof value === 'string' && value }) : [],
        teamRef: asString(raw.teamRef) || null,
        mcp: stringList(raw.mcp, MAX_MEMBER_MCP),
        skills: stringList(raw.skills),
      }
    }

    /** Request templates (`entry`): `{ id, label, template }`, ids made unique. */
    function normalizeEntryList(value) {
      const out = []
      const taken = {}
      if (!Array.isArray(value)) return out
      value.forEach(function (raw) {
        if (!isObject(raw)) return
        let id = asString(raw.id)
        if (!NODE_ID_PATTERN.test(id) || taken[id]) id = freshId('p', taken)
        taken[id] = true
        out.push({ id: id, label: asString(raw.label), template: asString(raw.template) })
      })
      return out.slice(0, MAX_ENTRY)
    }

    function normalizeFlowNode(raw) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      if (!NODE_ID_PATTERN.test(id)) return null
      const type = NODE_TYPES.indexOf(raw.type) >= 0 ? raw.type : 'step'
      const node = { id: id, type: type, x: Math.round(finiteNumber(raw.x, 0)), y: Math.round(finiteNumber(raw.y, 0)) }
      if (type === 'group' || type === 'note') {
        if (typeof raw.w === 'number' && isFinite(raw.w)) node.w = Math.round(raw.w)
        if (typeof raw.h === 'number' && isFinite(raw.h)) node.h = Math.round(raw.h)
      }
      node.label = asString(raw.label)
      node.detail = asString(raw.detail)
      if (type === 'step') node.memberId = asString(raw.memberId) || null
      if (type === 'team') node.teamRef = asString(raw.teamRef) || null
      if (isHexColor(raw.color)) node.color = raw.color
      return node
    }

    function normalizeFlowEdge(raw, nodeIds) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      const from = asString(raw.from)
      const to = asString(raw.to)
      if (!NODE_ID_PATTERN.test(id) || !nodeIds[from] || !nodeIds[to] || from === to) return null
      return {
        id: id,
        from: from,
        to: to,
        label: asString(raw.label),
        kind: EDGE_KINDS.indexOf(raw.kind) >= 0 ? raw.kind : 'flow',
      }
    }

    function normalizeFlow(raw) {
      const source = isObject(raw) ? raw : {}
      const nodes = []
      const nodeIds = {}
      ;(Array.isArray(source.nodes) ? source.nodes : []).forEach(function (rawNode) {
        const node = normalizeFlowNode(rawNode)
        if (node && !nodeIds[node.id]) {
          nodeIds[node.id] = true
          nodes.push(node)
        }
      })
      const edges = []
      const edgeIds = {}
      ;(Array.isArray(source.edges) ? source.edges : []).forEach(function (rawEdge) {
        const edge = normalizeFlowEdge(rawEdge, nodeIds)
        if (edge && !edgeIds[edge.id]) {
          edgeIds[edge.id] = true
          edges.push(edge)
        }
      })
      return { nodes: nodes, edges: edges }
    }

    function normalizeTeamRecord(raw) {
      if (!isObject(raw)) return null
      const members = []
      const memberIds = {}
      ;(Array.isArray(raw.members) ? raw.members : []).forEach(function (rawMember) {
        const member = normalizeMember(rawMember)
        if (member && !memberIds[member.id]) {
          memberIds[member.id] = true
          members.push(member)
        }
      })
      const lead = asString(raw.lead)
      return {
        id: asString(raw.id),
        name: asString(raw.name) || asString(raw.id) || 'Time',
        description: asString(raw.description),
        emoji: asString(raw.emoji) || '👥',
        color: isHexColor(raw.color) ? raw.color : TYPE_COLOR.group,
        workspaceDir: asString(raw.workspaceDir) || null,
        members: members,
        flow: normalizeFlow(raw.flow),
        lead: lead && memberIds[lead] ? lead : null,
        harness: asString(raw.harness) || null,
        bindWorkspace: raw.bindWorkspace === true,
        rules: asString(raw.rules),
        skills: stringList(raw.skills),
        entry: normalizeEntryList(raw.entry),
        shared: raw.shared === true,
        projectIds: stringList(raw.projectIds).filter(isProjectId),
        createdAt: asString(raw.createdAt),
        updatedAt: asString(raw.updatedAt),
      }
    }

    /** Editable part of a team, in the shape the Host accepts. */
    function teamPayload(team) {
      const members = (Array.isArray(team.members) ? team.members : []).map(normalizeMember).filter(Boolean)
      const lead = asString(team.lead)
      return {
        name: asString(team.name).trim(),
        description: asString(team.description),
        emoji: asString(team.emoji) || '👥',
        color: isHexColor(team.color) ? team.color : TYPE_COLOR.group,
        workspaceDir: asString(team.workspaceDir).trim() || null,
        members: members,
        flow: normalizeFlow(team.flow),
        lead: lead && members.some(function (member) { return member.id === lead }) ? lead : null,
        harness: asString(team.harness).trim() || null,
        bindWorkspace: team.bindWorkspace === true,
        rules: asString(team.rules),
        skills: stringList(team.skills),
        // Fully blank rows are editor scratch space: they are not sent (nor make the draft dirty).
        entry: normalizeEntryList(team.entry)
          .map(function (item) { return { id: item.id, label: item.label.trim(), template: item.template } })
          .filter(function (item) { return item.label || item.template.trim() }),
        shared: team.shared === true,
        // Order preserved; the non-shared one-project rule is enforced by the store and the editor.
        projectIds: stringList(team.projectIds).filter(isProjectId),
      }
    }

    /** First incomplete request template (label or template missing), or null. */
    function incompleteEntry(team) {
      const list = teamPayload(team).entry
      for (let index = 0; index < list.length; index += 1) {
        if (!list[index].label || !list[index].template.trim()) return list[index]
      }
      return null
    }

    /** Same directory regardless of trailing separators / surrounding spaces. */
    function sameDir(a, b) {
      const left = asString(a).trim().replace(/[\\/]+$/, '')
      const right = asString(b).trim().replace(/[\\/]+$/, '')
      return !!left && left === right
    }

    /* -------------------------- projects -------------------------- */

    /** `/api/bots.projects` record projection (CONTRACT.md §12.1). */
    function normalizeProjectRecord(raw) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      if (!isProjectId(id)) return null
      return {
        id: id,
        name: asString(raw.name) || id,
        description: asString(raw.description),
        emoji: asString(raw.emoji) || PROJECT_EMOJI,
        color: isHexColor(raw.color) ? raw.color : PROJECT_COLOR,
        createdAt: asString(raw.createdAt),
        updatedAt: asString(raw.updatedAt),
      }
    }

    /** Editable part of a project, in the shape the Host accepts (§12.2). */
    function projectPayload(project) {
      return {
        name: asString(project.name).trim(),
        description: asString(project.description),
        emoji: asString(project.emoji) || PROJECT_EMOJI,
        color: isHexColor(project.color) ? project.color : PROJECT_COLOR,
      }
    }

    /** Project record of `id` in `projects`, or null. */
    function findProject(projects, id) {
      const list = Array.isArray(projects) ? projects : []
      for (let index = 0; index < list.length; index += 1) {
        if (list[index].id === id) return list[index]
      }
      return null
    }

    /** Label used where a project is referenced by id only: emoji + name, or the unknown text. */
    function projectLabel(projects, id, t) {
      const project = findProject(projects, id)
      if (project) return project.emoji ? project.emoji + ' ' + project.name : project.name
      return t('projectUnknown') + ' (' + id + ')'
    }

    /**
     * A team that is not shared (`shared: false`) belongs to exactly one project, so
     * it is exclusive to it: it lists inside that project and no longer in the Times
     * tab. Shared teams stay in the Times tab as the reusable library (§12.4).
     */
    function teamIsProjectExclusive(team) {
      return isObject(team) && team.shared === false && Array.isArray(team.projectIds) && team.projectIds.length > 0
    }

    /* ----------------------- harness packs ------------------------ */

    /** Defensive PackSummary projection (CONTRACT.md §11.3). */
    function normalizePack(raw) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      if (!id) return null
      const source = isObject(raw.source) ? raw.source : {}
      const named = function (item) {
        if (typeof item === 'string') return item ? { name: item, description: '' } : null
        if (!isObject(item) || !asString(item.name)) return null
        return { name: asString(item.name), description: asString(item.description) }
      }
      let mcp = []
      if (Array.isArray(raw.mcp)) {
        mcp = stringList(raw.mcp.map(function (item) { return isObject(item) ? asString(item.name) : item }))
      } else if (isObject(raw.mcp)) {
        mcp = Object.keys(raw.mcp)
      }
      const version = raw.harnessVersion
      return {
        id: id,
        name: asString(raw.name) || id,
        sourceDir: asString(source.dir) || asString(raw.sourceDir),
        commit: asString(source.commit),
        packDir: asString(raw.packDir),
        harnessVersion: typeof version === 'number' && isFinite(version) ? version : (asString(version) || null),
        createdAt: asString(raw.createdAt),
        files: typeof raw.files === 'number' ? raw.files : null,
        agents: (Array.isArray(raw.agents) ? raw.agents : []).map(function (item) {
          if (!isObject(item) || !asString(item.name)) return null
          return {
            name: asString(item.name),
            description: asString(item.description),
            model: asString(item.model),
            effort: asString(item.effort),
            readOnly: item.readOnly === true,
            skills: stringList(item.skills),
          }
        }).filter(Boolean),
        skills: (Array.isArray(raw.skills) ? raw.skills : []).map(named).filter(Boolean),
        instructions: (Array.isArray(raw.instructions) ? raw.instructions : []).map(function (item) {
          if (typeof item === 'string') return item ? { name: item, applyTo: [] } : null
          if (!isObject(item) || !asString(item.name)) return null
          return { name: asString(item.name), applyTo: stringList(item.applyTo) }
        }).filter(Boolean),
        mcp: mcp,
        patches: (Array.isArray(raw.patches) ? raw.patches : []).map(function (item) {
          if (!isObject(item)) return null
          return { id: asString(item.id) || asString(item.file) || '?', applied: item.applied === true, reason: asString(item.reason) }
        }).filter(Boolean),
      }
    }

    function packVersionText(pack) {
      return pack && pack.harnessVersion !== null && pack.harnessVersion !== '' ? String(pack.harnessVersion) : '?'
    }

    function packStats(pack) {
      const applied = pack.patches.filter(function (patch) { return patch.applied }).length
      return {
        version: packVersionText(pack),
        agents: pack.agents.length,
        skills: pack.skills.length,
        instructions: pack.instructions.length,
        mcp: pack.mcp.length,
        applied: applied,
        total: pack.patches.length,
      }
    }

    function findPack(packs, id) {
      if (!id || !packs || !Array.isArray(packs.list)) return null
      for (let index = 0; index < packs.list.length; index += 1) {
        if (packs.list[index].id === id) return packs.list[index]
      }
      return null
    }

    /** Readable text for a failed request; missing routes get a dedicated hint. */
    function requestErrorText(error, t) {
      if (error && (error.code === 'HTTP_404' || error.code === 'NOT_FOUND' || error.code === 'ROUTE_NOT_FOUND')) return t('routeMissing')
      return describeError(error)
    }

    /** Card number from "123", "AB-123", "AB#123", "ab 123" or "#123". */
    function parseCardNumber(value) {
      const text = asString(value).trim()
      if (!text) return { digits: '', valid: true, pending: false }
      const match = /^(?:AB)?\s*[-#:]?\s*(\d{0,12})$/i.exec(text)
      if (!match) return { digits: '', valid: false, pending: false }
      return { digits: match[1], valid: true, pending: !match[1] }
    }

    /** Final request text: template filled with `{n}`/`{pedido}` (free text appended). */
    function buildRequestPrompt(entry, digits, details) {
      const extra = asString(details).trim()
      let text
      if (!entry) {
        text = extra
      } else {
        const template = asString(entry.template)
        text = template.split('{n}').join(digits).split('{pedido}').join(extra).trim()
        if (template.indexOf('{pedido}') < 0 && extra) text = text + '\n\n' + extra
      }
      return text || ''
    }

    function canonicalJson(team) {
      return JSON.stringify(teamPayload(team))
    }

    function teamStats(team) {
      let steps = 0
      team.flow.nodes.forEach(function (node) { if (node.type === 'step') steps += 1 })
      return { members: team.members.length, steps: steps, edges: team.flow.edges.length }
    }

    /* ---------------------------- API ----------------------------- */

    const teamsApi = {
      async list() {
        const payload = await fetchJson('/api/bots.teams')
        return (Array.isArray(payload.teams) ? payload.teams : []).map(normalizeTeamRecord).filter(function (team) { return team && team.id })
      },
      /** Template metadata only: the team is instantiated by `fromTemplate` (§5.2). */
      async templates() {
        const payload = await fetchJson('/api/bots.teams.templates')
        const list = []
        ;(Array.isArray(payload.templates) ? payload.templates : []).forEach(function (raw) {
          if (!isObject(raw) || !asString(raw.id)) return
          const team = isObject(raw.team) ? raw.team : {}
          list.push({
            id: asString(raw.id),
            name: asString(raw.name) || asString(team.name) || asString(raw.id),
            description: asString(raw.description) || asString(team.description),
            emoji: asString(raw.emoji) || asString(team.emoji) || '👥',
          })
        })
        return list
      },
      async create(team) {
        const payload = await fetchJson('/api/bots.teams.create', { team: teamPayload(team) })
        const record = normalizeTeamRecord(payload.team)
        if (!record || !record.id) throw apiError('BAD_RESPONSE', 'The server response is missing the team')
        return record
      },
      async update(id, team) {
        const payload = await fetchJson('/api/bots.teams.update', { id: id, patch: teamPayload(team) })
        const record = normalizeTeamRecord(payload.team)
        if (!record || !record.id) throw apiError('BAD_RESPONSE', 'The server response is missing the team')
        return record
      },
      async remove(id) {
        await fetchJson('/api/bots.teams.delete', { id: id })
      },
      /** Instantiate a template: fresh bits + the team they feed (§5.2). */
      async fromTemplate(input) {
        const body = { templateId: input.templateId }
        if (input.name) body.name = input.name
        if (input.projectId) body.projectId = input.projectId
        const payload = await fetchJson('/api/bots.teams.fromTemplate', body)
        const record = normalizeTeamRecord(payload.team)
        if (!record || !record.id) throw apiError('BAD_RESPONSE', 'The server response is missing the team')
        return {
          team: record,
          bits: (Array.isArray(payload.bits) ? payload.bits : []).map(normalizeBit).filter(Boolean),
        }
      },
      /** Team with a lead + one member per preset of a harness pack (§5.3). */
      async fromPack(packId) {
        const payload = await fetchJson('/api/bots.teams.fromPack', { packId: packId })
        const record = normalizeTeamRecord(payload.team)
        if (!record || !record.id) throw apiError('BAD_RESPONSE', 'The server response is missing the team')
        return {
          team: record,
          bits: (Array.isArray(payload.bits) ? payload.bits : []).map(normalizeBit).filter(Boolean),
        }
      },
      /** Start a mission: the host creates the session and delivers the prompt (§5.4). */
      async run(id, prompt) {
        const payload = await fetchJson('/api/bots.teams.run', { id: id, prompt: prompt })
        return {
          sessionId: asString(payload.sessionId) || asString(payload.mission && payload.mission.sessionId),
          workspaceId: asString(payload.workspaceId) || null,
          teamId: asString(payload.teamId),
          teamName: asString(payload.teamName),
          cwd: asString(payload.cwd),
        }
      },
      /** Register the team workspace in the Harness: `{ workspaceId, workspaceDir }`. */
      async workspace(id) {
        const payload = await fetchJson('/api/bots.teams.workspace', { id: id })
        return { workspaceId: asString(payload.workspaceId), workspaceDir: asString(payload.workspaceDir) }
      },
    }

    const projectsApi = {
      async list() {
        const payload = await fetchJson('/api/bots.projects')
        return (Array.isArray(payload.projects) ? payload.projects : []).map(normalizeProjectRecord).filter(function (project) { return project && project.id })
      },
      async create(project) {
        const payload = await fetchJson('/api/bots.projects.create', { project: projectPayload(project) })
        const record = normalizeProjectRecord(payload.project)
        if (!record || !record.id) throw apiError('BAD_RESPONSE', 'The server response is missing the project')
        return record
      },
      async update(id, project) {
        const payload = await fetchJson('/api/bots.projects.update', { id: id, patch: projectPayload(project) })
        const record = normalizeProjectRecord(payload.project)
        if (!record || !record.id) throw apiError('BAD_RESPONSE', 'The server response is missing the project')
        return record
      },
      async remove(id) {
        const payload = await fetchJson('/api/bots.projects.delete', { id: id })
        const detached = payload.detachedTeams
        return { detachedTeams: typeof detached === 'number' && isFinite(detached) ? detached : 0 }
      },
    }

    const harnessApi = {
      async list() {
        const payload = await fetchJson('/api/bots.harness')
        return (Array.isArray(payload.packs) ? payload.packs : []).map(normalizePack).filter(Boolean)
      },
      async importPack(input) {
        const body = { sourceDir: input.sourceDir, id: input.id }
        if (input.name) body.name = input.name
        const payload = await fetchJson('/api/bots.harness.import', body)
        const pack = normalizePack(payload.pack)
        if (!pack) throw apiError('BAD_RESPONSE', 'The server response is missing the pack')
        return pack
      },
    }

    /* --------------------- pure draft mutations -------------------- */

    function withFlow(draft, nodes, edges) {
      return Object.assign({}, draft, { flow: { nodes: nodes, edges: edges === undefined ? draft.flow.edges : edges } })
    }

    function addNodeTo(draft, node) {
      return withFlow(draft, draft.flow.nodes.concat([node]))
    }

    function patchNode(draft, id, patch) {
      let changed = false
      const nodes = draft.flow.nodes.map(function (node) {
        if (node.id !== id) return node
        changed = true
        const next = Object.assign({}, node, patch)
        Object.keys(next).forEach(function (key) { if (next[key] === undefined) delete next[key] })
        return next
      })
      return changed ? withFlow(draft, nodes) : draft
    }

    function moveNodesBy(draft, origins, dx, dy) {
      const nodes = draft.flow.nodes.map(function (node) {
        const origin = origins[node.id]
        if (!origin) return node
        const x = snap(origin.x + dx)
        const y = snap(origin.y + dy)
        if (x === node.x && y === node.y) return node
        return Object.assign({}, node, { x: x, y: y })
      })
      return withFlow(draft, nodes)
    }

    function removeFromFlow(draft, nodeIds, edgeIds) {
      const dropNode = {}
      ;(nodeIds || []).forEach(function (id) { dropNode[id] = true })
      const dropEdge = {}
      ;(edgeIds || []).forEach(function (id) { dropEdge[id] = true })
      const nodes = draft.flow.nodes.filter(function (node) { return !dropNode[node.id] })
      const edges = draft.flow.edges.filter(function (edge) {
        return !dropEdge[edge.id] && !dropNode[edge.from] && !dropNode[edge.to]
      })
      if (nodes.length === draft.flow.nodes.length && edges.length === draft.flow.edges.length) return draft
      return withFlow(draft, nodes, edges)
    }

    function addEdgeTo(draft, from, to, kind) {
      if (from === to) return { draft: draft, id: null }
      const exists = draft.flow.edges.some(function (edge) { return edge.from === from && edge.to === to })
      if (exists) return { draft: draft, id: null }
      const id = freshId('e', indexBy(draft.flow.edges))
      const edge = { id: id, from: from, to: to, label: '', kind: kind || 'flow' }
      return { draft: withFlow(draft, draft.flow.nodes, draft.flow.edges.concat([edge])), id: id }
    }

    function patchEdge(draft, id, patch) {
      let changed = false
      const edges = draft.flow.edges.map(function (edge) {
        if (edge.id !== id) return edge
        changed = true
        return Object.assign({}, edge, patch)
      })
      return changed ? withFlow(draft, draft.flow.nodes, edges) : draft
    }

    /** Copy nodes (and the edges among them) 32 px down/right with fresh ids. */
    function duplicateNodes(draft, ids) {
      const wanted = {}
      ids.forEach(function (id) { wanted[id] = true })
      const takenNodes = indexBy(draft.flow.nodes)
      const mapping = {}
      const copies = []
      draft.flow.nodes.forEach(function (node) {
        if (!wanted[node.id]) return
        const id = freshId('n', takenNodes)
        takenNodes[id] = true
        mapping[node.id] = id
        copies.push(Object.assign({}, node, { id: id, x: node.x + 32, y: node.y + 32 }))
      })
      const takenEdges = indexBy(draft.flow.edges)
      const edgeCopies = []
      draft.flow.edges.forEach(function (edge) {
        if (!mapping[edge.from] || !mapping[edge.to]) return
        const id = freshId('e', takenEdges)
        takenEdges[id] = true
        edgeCopies.push(Object.assign({}, edge, { id: id, from: mapping[edge.from], to: mapping[edge.to] }))
      })
      return {
        draft: withFlow(draft, draft.flow.nodes.concat(copies), draft.flow.edges.concat(edgeCopies)),
        ids: copies.map(function (node) { return node.id }),
      }
    }

    function patchMember(draft, id, patch) {
      return Object.assign({}, draft, {
        members: draft.members.map(function (member) {
          return member.id === id ? Object.assign({}, member, patch) : member
        }),
      })
    }

    function removeMemberFrom(draft, id) {
      const members = draft.members
        .filter(function (member) { return member.id !== id })
        .map(function (member) {
          return member.launches.indexOf(id) >= 0
            ? Object.assign({}, member, { launches: member.launches.filter(function (other) { return other !== id }) })
            : member
        })
      const nodes = draft.flow.nodes.map(function (node) {
        return node.type === 'step' && node.memberId === id ? Object.assign({}, node, { memberId: null }) : node
      })
      return Object.assign({}, draft, {
        members: members,
        flow: { nodes: nodes, edges: draft.flow.edges },
        lead: draft.lead === id ? null : draft.lead,
      })
    }

    function memberFromBit(bit, members, catalog, lang) {
      const character = bitCharacter(bit, catalog)
      return {
        id: memberSlug(bit.name, members),
        bitId: bit.id,
        role: character ? summaryOf(character, lang).slice(0, 200) : excerpt(bit.instructions, 200),
        access: 'write',
        launches: [],
        teamRef: null,
        mcp: [],
        skills: [],
      }
    }

    /* ------------------------ edge geometry ------------------------ */

    function anchorOn(rect, side, shift) {
      if (side === 'right') return { x: rect.x + rect.w, y: rect.y + rect.h / 2 + shift, nx: 1, ny: 0 }
      if (side === 'left') return { x: rect.x, y: rect.y + rect.h / 2 + shift, nx: -1, ny: 0 }
      if (side === 'bottom') return { x: rect.x + rect.w / 2 + shift, y: rect.y + rect.h, nx: 0, ny: 1 }
      return { x: rect.x + rect.w / 2 + shift, y: rect.y, nx: 0, ny: -1 }
    }

    /** Cubic bezier between the facing sides of two rects; `shift` separates twin edges. */
    function edgeGeometry(a, b, shift) {
      const acx = a.x + a.w / 2
      const acy = a.y + a.h / 2
      const bcx = b.x + b.w / 2
      const bcy = b.y + b.h / 2
      const dx = bcx - acx
      const dy = bcy - acy
      const horizontal = Math.abs(dx) / Math.max(1, (a.w + b.w) / 2) >= Math.abs(dy) / Math.max(1, (a.h + b.h) / 2)
      let sideA
      let sideB
      if (horizontal) {
        sideA = dx >= 0 ? 'right' : 'left'
        sideB = dx >= 0 ? 'left' : 'right'
      } else {
        sideA = dy >= 0 ? 'bottom' : 'top'
        sideB = dy >= 0 ? 'top' : 'bottom'
      }
      const p1 = anchorOn(a, sideA, shift)
      const p2 = anchorOn(b, sideB, shift)
      const distance = Math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y))
      const pull = clamp(distance * 0.42, 28, 180)
      const c1x = p1.x + p1.nx * pull
      const c1y = p1.y + p1.ny * pull
      const c2x = p2.x + p2.nx * pull
      const c2y = p2.y + p2.ny * pull
      return {
        d: 'M' + p1.x + ',' + p1.y + ' C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + p2.x + ',' + p2.y,
        mx: (p1.x + 3 * c1x + 3 * c2x + p2.x) / 8,
        my: (p1.y + 3 * c1y + 3 * c2y + p2.y) / 8,
      }
    }

    function handlePoint(rect, side) {
      const anchor = anchorOn(rect, side, 0)
      return { x: anchor.x, y: anchor.y }
    }

    /* --------------------------- history --------------------------- */

    /** Draft + undo/redo stacks; `coalesce` merges rapid edits of one field. */
    function useFlowHistory(initial) {
      const [state, setState] = React.useState(function () {
        return { draft: initial, past: [], future: [], key: null, at: 0 }
      })
      const commit = React.useCallback(function (updater, coalesce) {
        setState(function (previous) {
          const next = updater(previous.draft)
          if (!next || next === previous.draft) return previous
          const now = Date.now()
          const merge = !!coalesce && previous.key === coalesce && now - previous.at < 1500
          return {
            draft: next,
            past: merge ? previous.past : previous.past.concat([previous.draft]).slice(-HISTORY_LIMIT),
            future: [],
            key: coalesce || null,
            at: now,
          }
        })
      }, [])
      const checkpoint = React.useCallback(function () {
        setState(function (previous) {
          return { draft: previous.draft, past: previous.past.concat([previous.draft]).slice(-HISTORY_LIMIT), future: [], key: null, at: 0 }
        })
      }, [])
      const transient = React.useCallback(function (updater) {
        setState(function (previous) {
          const next = updater(previous.draft)
          if (!next || next === previous.draft) return previous
          return { draft: next, past: previous.past, future: previous.future, key: previous.key, at: previous.at }
        })
      }, [])
      const undo = React.useCallback(function () {
        setState(function (previous) {
          if (previous.past.length === 0) return previous
          return {
            draft: previous.past[previous.past.length - 1],
            past: previous.past.slice(0, -1),
            future: [previous.draft].concat(previous.future).slice(0, HISTORY_LIMIT),
            key: null,
            at: 0,
          }
        })
      }, [])
      const redo = React.useCallback(function () {
        setState(function (previous) {
          if (previous.future.length === 0) return previous
          return {
            draft: previous.future[0],
            past: previous.past.concat([previous.draft]).slice(-HISTORY_LIMIT),
            future: previous.future.slice(1),
            key: null,
            at: 0,
          }
        })
      }, [])
      const replace = React.useCallback(function (draft) {
        setState(function (previous) {
          return { draft: draft, past: previous.past, future: previous.future, key: null, at: 0 }
        })
      }, [])
      return {
        draft: state.draft,
        canUndo: state.past.length > 0,
        canRedo: state.future.length > 0,
        commit: commit,
        checkpoint: checkpoint,
        transient: transient,
        undo: undo,
        redo: redo,
        replace: replace,
      }
    }

    /* --------------------------- tabs ------------------------------ */

    function readStoredTab() {
      try {
        const value = window.localStorage.getItem(TAB_STORAGE_KEY)
        return value === 'teams' || value === 'projects' ? value : 'bots'
      } catch (error) {
        return 'bots'
      }
    }

    function storeTab(tab) {
      try { window.localStorage.setItem(TAB_STORAGE_KEY, tab) } catch (error) { /* best effort */ }
    }

    function PageTabs(props) {
      const t = props.t
      const items = [
        { id: 'bots', label: t('tabBots'), icon: h(BotsGlyph, { size: 15 }) },
        { id: 'teams', label: t('tabTeams'), icon: h(TeamGlyph, { size: 15 }) },
        { id: 'projects', label: t('tabProjects'), icon: h(ProjectsGlyph, { size: 15 }) },
      ]
      return h('div', { className: 'dsh-bots-tabs', role: 'tablist', 'aria-label': t('tabsLabel') },
        items.map(function (item) {
          const selected = props.tab === item.id
          return h('button', {
            key: item.id,
            type: 'button',
            role: 'tab',
            className: 'dsh-bots-tab',
            'aria-selected': selected ? 'true' : 'false',
            tabIndex: selected ? 0 : -1,
            onClick: function () { props.onChange(item.id) },
            onKeyDown: function (event) {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              const index = items.findIndex(function (entry) { return entry.id === props.tab })
              const step = event.key === 'ArrowRight' ? 1 : -1
              const next = items[(Math.max(0, index) + step + items.length) % items.length]
              props.onChange(next.id)
            },
          }, item.icon, item.label)
        })
      )
    }

    /* ------------------------ team list view ----------------------- */

    /** Small static preview of a flow for the team cards. */
    function FlowThumb(props) {
      const team = props.team
      const nodes = team.flow.nodes
      const bounds = flowBounds(nodes)
      if (!bounds) return h('div', { className: 'dsh-team-thumb dsh-team-thumb-empty' }, props.emptyLabel)
      const pad = 48
      const viewBox = [bounds.x - pad, bounds.y - pad, bounds.w + pad * 2, bounds.h + pad * 2].join(' ')
      const membersById = indexBy(team.members)
      const bitsById = props.bitsById || {}
      const rects = indexBy(nodes.map(function (node) { const rect = nodeRect(node); rect.id = node.id; return rect }))
      const groups = nodes.filter(function (node) { return node.type === 'group' })
      const others = nodes.filter(function (node) { return node.type !== 'group' })
      return h('svg', { className: 'dsh-team-thumb', viewBox: viewBox, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', focusable: 'false' },
        groups.map(function (node) {
          const color = nodeColor(node, membersById, props.catalog, bitsById)
          const rect = rects[node.id]
          return h('rect', {
            key: node.id, x: rect.x, y: rect.y, width: rect.w, height: rect.h, rx: 16,
            fill: hexAlpha(color, 0.07), stroke: hexAlpha(color, 0.5), strokeWidth: 1.5,
            strokeDasharray: '6 5', vectorEffect: 'non-scaling-stroke',
          })
        }),
        team.flow.edges.map(function (edge) {
          const a = rects[edge.from]
          const b = rects[edge.to]
          if (!a || !b) return null
          return h('path', {
            key: edge.id, d: edgeGeometry(a, b, 0).d, fill: 'none',
            stroke: edge.kind === 'loop' ? 'var(--dsh-bots-warn)' : (edge.kind === 'delegate' ? 'var(--dsh-bots-accent)' : (edge.kind === 'handoff' ? HANDOFF_COLOR : 'var(--dsh-bots-text-3)')),
            strokeWidth: 1, vectorEffect: 'non-scaling-stroke', opacity: 0.8,
          })
        }),
        others.map(function (node) {
          const color = nodeColor(node, membersById, props.catalog, bitsById)
          const rect = rects[node.id]
          return h('rect', {
            key: node.id, x: rect.x, y: rect.y, width: rect.w, height: rect.h,
            rx: node.type === 'start' || node.type === 'end' ? rect.h / 2 : 10,
            fill: hexAlpha(color, node.type === 'note' ? 0.16 : 0.22), stroke: color, strokeWidth: 1.2,
            vectorEffect: 'non-scaling-stroke',
          })
        })
      )
    }

    function MemberStack(props) {
      const members = props.members
      const shown = members.slice(0, props.max || 7)
      const bitsById = props.bitsById || {}
      return h('div', { className: 'dsh-team-stack' },
        shown.map(function (member) {
          const bit = memberBit(member, bitsById)
          return h(BitAvatar, { key: member.id, bit: avatarBitOf(bit, props.catalog), size: 30, emoji: '🤖', color: TYPE_COLOR.end })
        }),
        members.length > shown.length ? h('span', { className: 'dsh-team-more' }, '+' + (members.length - shown.length)) : null
      )
    }

    function TeamCard(props) {
      const t = props.t
      const team = props.team
      const bitsById = props.bitsById || {}
      const stats = teamStats(team)
      const description = excerpt(team.description, 220)
      const lead = team.lead ? team.members.find(function (member) { return member.id === team.lead }) || null : null
      const leadName = lead ? memberName(lead, bitsById) : ''
      const pack = team.harness ? findPack(props.packs, team.harness) : null
      // A mission needs a workspace and an orchestrator bit as lead (V5-CONTRACT.md §6.2).
      const runnable = !!team.workspaceDir && !!lead && memberIsOrchestrator(lead, bitsById)
      const badges = []
      if (lead) badges.push(h(Badge, { key: 'lead', tone: memberIsOrchestrator(lead, bitsById) ? 'info' : 'warn', dot: false, label: tf(t, 'leadOf', { name: leadName }) }))
      if (team.harness) {
        badges.push(h(Badge, {
          key: 'harness', dot: false,
          title: pack ? pack.name : undefined,
          label: pack ? tf(t, 'harnessBadge', { id: team.harness, version: packVersionText(pack) }) : tf(t, 'harnessBadgeNoVersion', { id: team.harness }),
        }))
      }
      if (team.bindWorkspace) badges.push(h(Badge, { key: 'bound', tone: 'ok', label: t('workspaceBound'), title: team.workspaceDir || undefined }))
      if (team.shared) badges.push(h(Badge, { key: 'shared', tone: 'info', dot: false, label: t('sharedBadge') }))
      team.projectIds.forEach(function (id) {
        const project = findProject(props.projects, id)
        badges.push(h(Badge, {
          key: 'project-' + id,
          dot: false,
          title: project ? (project.description || project.name) : id,
          label: project ? (project.emoji ? project.emoji + ' ' : '') + project.name : t('projectUnknown'),
        }))
      })
      return h('li', { className: 'dsh-bots-card', 'data-team-id': team.id },
        h('div', { className: 'dsh-bots-card-head' },
          h('span', {
            className: 'dsh-bots-avatar',
            'aria-hidden': 'true',
            style: { width: 44, height: 44, fontSize: 22, background: hexAlpha(team.color, 0.16) },
          }, team.emoji || '👥'),
          h('div', { className: 'dsh-bots-card-titles' },
            h('div', { className: 'dsh-bots-name-row' },
              h('h3', { className: 'dsh-bots-name', title: team.name }, team.name)),
            h('p', { className: 'dsh-bots-role' }, tf(t, 'teamStats', stats))
          )
        ),
        h('div', {
          className: 'dsh-team-open',
          role: 'presentation',
          onClick: function () { props.onOpen(team) },
        }, h(FlowThumb, { team: team, catalog: props.catalog, bitsById: bitsById, emptyLabel: t('emptyCanvas') })),
        h('p', { className: 'dsh-bots-persona' + (description ? '' : ' dsh-bots-persona-empty'), title: description || undefined }, description || t('noDescription')),
        badges.length > 0 ? h('div', { className: 'dsh-team-badges' }, badges) : null,
        team.members.length > 0 ? h(MemberStack, { members: team.members, catalog: props.catalog, bitsById: bitsById }) : null,
        team.workspaceDir
          ? h('div', { className: 'dsh-bots-meta' },
            h('span', { className: 'dsh-bots-meta-label' }, t('workspace')),
            h('span', { className: 'dsh-bots-path', title: team.workspaceDir }, team.workspaceDir))
          : null,
        h('div', { className: 'dsh-bots-actions' },
          runnable
            ? h(Button, { variant: 'primary', size: 'sm', onClick: function () { props.onSend(team) } }, h(SendIcon, { size: 14 }), t('sendRequest'))
            : null,
          h(Button, { variant: runnable ? 'outline' : 'primary', size: 'sm', onClick: function () { props.onOpen(team) } }, h(FlowIcon, { size: 14 }), t('openFlow')),
          runnable
            ? h(IconButton, { label: t('duplicateTeam'), className: 'dsh-bots-icon-button-sm', onClick: function () { props.onDuplicate(team) } }, h(CopyIcon, { size: 14 }))
            : h(Button, { variant: 'outline', size: 'sm', onClick: function () { props.onDuplicate(team) } }, h(CopyIcon, { size: 14 }), t('duplicateTeam')),
          h(IconButton, { label: t('exportTeam'), className: 'dsh-bots-icon-button-sm', onClick: function () { props.onExport(team) } }, h(DownloadIcon, { size: 14 })),
          typeof props.onDetach === 'function'
            ? h(Button, { variant: 'outline', size: 'sm', onClick: function () { props.onDetach(team) } }, t('removeFromProject'))
            : null,
          h('span', { className: 'dsh-bots-actions-grow' }),
          h(Button, { variant: 'ghost', size: 'sm', className: 'dsh-bots-button-danger', onClick: function () { props.onDelete(team) } }, h(TrashIcon, { size: 14 }), t('deleteTeam'))
        )
      )
    }

    /**
     * "Enviar pedido": pick a template, fill `{n}`/`{pedido}`, preview, then start
     * the mission through `POST /api/bots.teams.run` (V5-CONTRACT.md §5.4/§8).
     */
    function SendRequestDialog(props) {
      const t = props.t
      const team = props.team
      const entries = team.entry.filter(function (item) { return item.label.trim() && item.template.trim() })
      const [choice, setChoice] = React.useState(entries.length > 0 ? entries[0].id : 'free')
      const [number, setNumber] = React.useState('')
      const [details, setDetails] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [done, setDone] = React.useState(null)
      const numberRef = React.useRef(null)
      const detailsRef = React.useRef(null)
      const entry = choice === 'free' ? null : entries.find(function (item) { return item.id === choice }) || null
      const needsNumber = !!entry && entry.template.indexOf('{n}') >= 0
      const usesDetails = !entry || entry.template.indexOf('{pedido}') >= 0
      const card = parseCardNumber(number)
      const prompt = buildRequestPrompt(entry, card.digits, details)
      const numberMissing = needsNumber && !card.digits
      const blocked = busy || numberMissing || !card.valid || !prompt || (!entry && !details.trim())

      function pick(id) {
        setChoice(id)
        setError(null)
      }

      function changeNumber(value) {
        const parsed = parseCardNumber(value)
        // "AB-123" / "AB#123" collapse to the digits as soon as they are complete.
        setNumber(parsed.valid && parsed.digits && /\D/.test(value.trim()) ? parsed.digits : value)
        setError(null)
      }

      async function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (blocked || done) return
        setBusy(true)
        setError(null)
        try {
          const outcome = await props.onSubmit(team, prompt)
          if (outcome && outcome.opened) return
          setDone(outcome || {})
        } catch (reason) {
          setError(requestErrorText(reason, t))
        } finally {
          setBusy(false)
        }
      }

      const choices = entries.map(function (item) {
        return { id: item.id, name: item.label, description: item.template, mono: true }
      }).concat([{ id: 'free', name: t('sendFree'), description: t('sendFreeHint'), mono: false }])
      const footer = done
        ? [h('button', { key: 'close', type: 'button', className: 'dsh-bots-button dsh-bots-button-primary', onClick: props.onCancel }, t('runClose'))]
        : [
          h('button', { key: 'cancel', type: 'button', className: 'dsh-bots-button dsh-bots-button-outline', disabled: busy, onClick: props.onCancel }, t('cancel')),
          h('button', {
            key: 'ok', type: 'button', className: 'dsh-bots-button dsh-bots-button-primary', disabled: blocked,
            'aria-busy': busy ? 'true' : undefined, onClick: submit,
          }, h(SendIcon, { size: 14 }), busy ? t('sendOpening') : t('sendSubmit')),
        ]
      const detailsLabel = !entry ? t('sendDetailsFree') : (usesDetails ? t('sendDetails') : t('sendDetailsExtra'))

      const doneText = done
        ? (done.sessionId
          ? t('sendStarted') + ': ' + done.sessionId
          : t('sendStarted') + (done.teamName ? ' · ' + done.teamName : ''))
        : ''
      return h(Modal, {
        t: t, title: tf(t, 'sendRequestTitle', { name: team.name }), wide: true,
        initialFocusRef: needsNumber ? numberRef : detailsRef,
        onClose: props.onCancel, dismissDisabled: busy, footer: footer,
      },
        done
          ? h('div', { className: 'dsh-bots-field' },
            h('p', { className: 'dsh-team-okbox', role: 'status' }, doneText),
            h('p', { className: 'dsh-bots-hint' }, t('sendStartedHint')),
            h('p', { className: 'dsh-bots-hint' }, t('sendOpenFailed')))
          : h('form', { onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: 14 } },
            h(Field, { label: t('sendTemplate'), htmlFor: 'dsh-send-template' },
              h('ul', { className: 'dsh-team-choices', role: 'radiogroup', id: 'dsh-send-template', 'aria-label': t('sendTemplate') },
                choices.map(function (item) {
                  return h('li', { key: item.id },
                    h('button', {
                      type: 'button', role: 'radio', className: 'dsh-team-choice',
                      'aria-checked': choice === item.id ? 'true' : 'false',
                      onClick: function () { pick(item.id) },
                    },
                      h('span', { className: 'dsh-team-choice-emoji', 'aria-hidden': 'true' }, item.id === 'free' ? h(EditIcon, { size: 16 }) : h(SendIcon, { size: 16 })),
                      h('span', { className: 'dsh-team-choice-text' },
                        h('span', { className: 'dsh-team-choice-name' }, item.name),
                        item.description ? h('span', { className: 'dsh-team-choice-desc' + (item.mono ? ' dsh-team-choice-mono' : '') }, excerpt(item.description, 220)) : null)))
                }))),
            needsNumber
              ? h(Field, {
                label: t('sendNumber'), htmlFor: 'dsh-send-number',
                hint: numberMissing && card.valid ? t('sendNumberRequired') + ' ' + t('sendNumberHint') : t('sendNumberHint'),
                error: !card.valid ? t('sendNumberInvalid') : null,
              },
                h('input', {
                  id: 'dsh-send-number', ref: numberRef, className: 'dsh-bots-input', value: number, inputMode: 'numeric',
                  autoComplete: 'off', spellCheck: false, maxLength: 20, placeholder: '123',
                  style: { maxWidth: 180, fontFamily: 'var(--dsh-bots-mono)' },
                  'aria-invalid': !card.valid ? 'true' : undefined,
                  onChange: function (event) { changeNumber(event.target.value) },
                  onBlur: function () { if (card.valid && card.digits) setNumber(card.digits) },
                }))
              : null,
            h(Field, { label: detailsLabel, htmlFor: 'dsh-send-details' },
              h('textarea', {
                id: 'dsh-send-details', ref: detailsRef, className: 'dsh-bots-textarea dsh-team-textarea-sm', value: details,
                maxLength: 20000, placeholder: t('sendDetailsPlaceholder'),
                onChange: function (event) { setDetails(event.target.value); setError(null) },
              })),
            h(Field, { label: t('sendPreview'), htmlFor: 'dsh-send-preview' },
              h('pre', { id: 'dsh-send-preview', className: 'dsh-team-preview' + (prompt ? '' : ' dsh-team-preview-empty'), 'aria-live': 'polite' }, prompt || t('sendPreviewEmpty'))),
            error ? h('p', { className: 'dsh-bots-error dsh-bots-form-error', role: 'alert' }, error) : null,
            h('button', { type: 'submit', hidden: true, tabIndex: -1 })
          )
      )
    }

    /** Harness packs: list, import from a repository, create a team from a pack (§11.2–11.3). */
    function HarnessDialog(props) {
      const t = props.t
      const packs = props.packs
      const sourceRef = React.useRef(null)
      const [sourceDir, setSourceDir] = React.useState('')
      const [packId, setPackId] = React.useState('')
      const [idTouched, setIdTouched] = React.useState(false)
      const [name, setName] = React.useState('')
      const [busy, setBusy] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [imported, setImported] = React.useState(null)
      const [rowError, setRowError] = React.useState(null)

      const sourceBad = sourceDir.trim() !== '' && !ABSOLUTE_PATH_PATTERN.test(sourceDir.trim())
      const idBad = packId.trim() !== '' && !PACK_ID_PATTERN.test(packId.trim())
      const canImport = !busy && sourceDir.trim() !== '' && !sourceBad && packId.trim() !== '' && !idBad

      function changeSource(value) {
        setSourceDir(value)
        setError(null)
        if (!idTouched) {
          const base = value.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
          setPackId(foldText(base).replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64))
        }
      }

      async function submitImport(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (!canImport) return
        setBusy({ kind: 'import' })
        setError(null)
        setImported(null)
        try {
          const pack = await harnessApi.importPack({ sourceDir: sourceDir.trim(), id: packId.trim(), name: name.trim() })
          setImported(pack)
          if (typeof props.onImported === 'function') props.onImported(pack)
        } catch (reason) {
          setError(requestErrorText(reason, t))
        } finally {
          setBusy(null)
        }
      }

      async function createTeam(pack) {
        if (busy) return
        setBusy({ kind: 'team', id: pack.id })
        setRowError(null)
        try {
          await props.onCreateTeam(pack)
        } catch (reason) {
          setBusy(null)
          setRowError({ id: pack.id, text: requestErrorText(reason, t) })
        }
      }

      let list
      if (packs.phase === 'loading' || packs.phase === 'idle') {
        list = h('p', { className: 'dsh-bots-hint', role: 'status' }, t('packsLoading'))
      } else if (packs.phase === 'error' && packs.list.length === 0) {
        list = h('div', { className: 'dsh-bots-banner', role: 'alert' },
          h('span', { className: 'dsh-bots-banner-text' }, t('packsError') + ' ' + (packs.error || '')),
          h(Button, { variant: 'outline', size: 'sm', onClick: props.onReload }, t('retry')))
      } else if (packs.list.length === 0) {
        list = h('p', { className: 'dsh-bots-hint' }, t('packsEmpty'))
      } else {
        list = h('ul', { className: 'dsh-team-packs' }, packs.list.map(function (pack) {
          const stats = packStats(pack)
          const skipped = pack.patches.filter(function (patch) { return !patch.applied })
          const creating = !!busy && busy.kind === 'team' && busy.id === pack.id
          return h('li', { key: pack.id, className: 'dsh-team-pack' },
            h('div', { className: 'dsh-team-pack-head' },
              h('h3', { className: 'dsh-team-pack-name', title: pack.name }, pack.name),
              h(Badge, { dot: false, label: pack.id, title: pack.packDir || undefined }),
              h(Badge, { dot: false, tone: 'info', label: pack.harnessVersion !== null ? 'v' + stats.version : t('packVersionUnknown') })),
            pack.sourceDir
              ? h('div', { className: 'dsh-bots-meta' },
                h('span', { className: 'dsh-bots-meta-label' }, t('packSource')),
                h('span', { className: 'dsh-bots-path', title: pack.sourceDir + (pack.commit ? ' @ ' + pack.commit : '') }, pack.sourceDir + (pack.commit ? ' @ ' + pack.commit.slice(0, 8) : '')))
              : null,
            h('p', { className: 'dsh-team-summary' }, tf(t, 'packCounts', stats)),
            h('p', { className: 'dsh-team-summary', style: { color: skipped.length > 0 ? 'var(--dsh-bots-warn)' : undefined } }, tf(t, 'packPatches', stats)),
            skipped.length > 0
              ? h('ul', { className: 'dsh-team-pack-skips' }, skipped.map(function (patch) {
                return h('li', { key: patch.id }, patch.id + (patch.reason ? ': ' + patch.reason : ''))
              }))
              : null,
            rowError && rowError.id === pack.id ? h('p', { className: 'dsh-bots-error', role: 'alert' }, rowError.text) : null,
            h('div', { className: 'dsh-team-pack-actions' },
              h(Button, { variant: 'outline', size: 'sm', disabled: !!busy, busy: creating, onClick: function () { createTeam(pack) } },
                h(TeamGlyph, { size: 14 }), creating ? t('creating') : t('createFromPack'))))
        }))
      }

      const footer = [
        h('button', { key: 'close', type: 'button', className: 'dsh-bots-button dsh-bots-button-outline', disabled: !!busy, onClick: props.onClose }, t('close')),
      ]
      return h(Modal, { t: t, title: t('harnessTitle'), wide: true, initialFocusRef: sourceRef, onClose: props.onClose, dismissDisabled: !!busy, footer: footer },
        h('p', { className: 'dsh-bots-hint' }, t('harnessIntro')),
        list,
        h('form', { onSubmit: submitImport, style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          h('h3', { className: 'dsh-team-subhead' }, t('importHarness')),
          h(Field, { label: t('importSourceDir'), htmlFor: 'dsh-harness-source', hint: t('importSourceHint'), error: sourceBad ? t('workspaceInvalid') : null },
            h('input', {
              id: 'dsh-harness-source', ref: sourceRef, className: 'dsh-bots-input', value: sourceDir, maxLength: 1024,
              placeholder: '/home/…/repositorio', spellCheck: false, autoComplete: 'off',
              style: { fontFamily: 'var(--dsh-bots-mono)' }, 'aria-invalid': sourceBad ? 'true' : undefined,
              onChange: function (event) { changeSource(event.target.value) },
            })),
          h('div', { className: 'dsh-bots-row' },
            h(Field, { label: t('importId'), htmlFor: 'dsh-harness-id', grow: true, hint: t('importIdHint'), error: idBad ? t('importIdInvalid') : null },
              h('input', {
                id: 'dsh-harness-id', className: 'dsh-bots-input', value: packId, maxLength: 64, spellCheck: false, autoComplete: 'off',
                placeholder: 'dsc', style: { fontFamily: 'var(--dsh-bots-mono)' }, 'aria-invalid': idBad ? 'true' : undefined,
                onChange: function (event) { setPackId(event.target.value); setIdTouched(true); setError(null) },
              })),
            h(Field, { label: t('importName'), htmlFor: 'dsh-harness-name', grow: true },
              h('input', {
                id: 'dsh-harness-name', className: 'dsh-bots-input', value: name, maxLength: MAX_NAME,
                onChange: function (event) { setName(event.target.value) },
              }))),
          error ? h('p', { className: 'dsh-bots-error dsh-bots-form-error', role: 'alert' }, error) : null,
          imported
            ? h('p', { className: 'dsh-team-okbox', role: 'status' },
              t('importDone') + ': ' + imported.name + ' (' + imported.id + ') · ' + tf(t, 'packSummary', packStats(imported)))
            : null,
          h('div', { className: 'dsh-team-pack-actions' },
            h('button', {
              type: 'submit', className: 'dsh-bots-button dsh-bots-button-primary', disabled: !canImport,
              'aria-busy': busy && busy.kind === 'import' ? 'true' : undefined,
            }, h(UploadIcon, { size: 14 }), busy && busy.kind === 'import' ? t('importing') : t('importSubmit'))))
      )
    }

    /**
     * "Novo time": a blank team, or a template instantiated through
     * `POST /api/bots.teams.fromTemplate` (which creates fresh bits, §5.2).
     */
    function NewTeamDialog(props) {
      const t = props.t
      const nameRef = React.useRef(null)
      const [name, setName] = React.useState('')
      const [description, setDescription] = React.useState('')
      const [choice, setChoice] = React.useState('blank')
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const templates = props.templates
      const projectId = isProjectId(props.projectId) ? asString(props.projectId) : ''
      const chosen = choice === 'blank' ? null : templates.list.find(function (item) { return item.id === choice }) || null

      function pick(id) {
        setChoice(id)
        const template = templates.list.find(function (item) { return item.id === id })
        if (!name.trim() && template) setName(template.name)
        if (!description.trim() && template) setDescription(template.description)
      }

      function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (busy) return
        const trimmed = name.trim()
        if (!trimmed) {
          setError(t('teamNameRequired'))
          if (nameRef.current) nameRef.current.focus()
          return
        }
        let pending
        if (chosen) {
          // A template always creates fresh bits before the team (§5.2).
          pending = Promise.resolve(props.onCreateFromTemplate({
            templateId: chosen.id,
            name: trimmed.slice(0, MAX_NAME),
            projectId: projectId || null,
          }))
        } else {
          const base = {
            name: trimmed.slice(0, MAX_NAME),
            description: description,
            emoji: '👥',
            color: TYPE_COLOR.group,
            workspaceDir: null,
            members: [],
            flow: { nodes: [{ id: 'start', type: 'start', x: 0, y: 0, label: t('nodeStartDefault'), detail: '' }], edges: [] },
            // A team created inside a project belongs to it and is never shared (§12.4).
            projectIds: projectId ? [projectId] : [],
            shared: false,
          }
          pending = Promise.resolve(props.onCreate(base))
        }
        setBusy(true)
        setError(null)
        pending.catch(function (reason) {
          setBusy(false)
          setError(describeError(reason))
        })
      }

      const choices = [{ id: 'blank', name: t('blankTeam'), description: t('blankTeamHint'), emoji: '✳️' }].concat(templates.list)
      const footer = [
        h('button', { key: 'cancel', type: 'button', className: 'dsh-bots-button dsh-bots-button-outline', disabled: busy, onClick: props.onCancel }, t('cancel')),
        h('button', { key: 'ok', type: 'button', className: 'dsh-bots-button dsh-bots-button-primary', disabled: busy, 'aria-busy': busy ? 'true' : undefined, onClick: submit }, busy ? t('creating') : t('createTeam')),
      ]
      return h(Modal, { t: t, title: t('newTeam'), wide: true, initialFocusRef: nameRef, onClose: props.onCancel, dismissDisabled: busy, footer: footer },
        h('form', { onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h(Field, { label: t('startFrom'), htmlFor: 'dsh-team-template' },
            h('ul', { className: 'dsh-team-choices', role: 'radiogroup', id: 'dsh-team-template', 'aria-label': t('startFrom') },
              choices.map(function (item) {
                return h('li', { key: item.id },
                  h('button', {
                    type: 'button',
                    role: 'radio',
                    className: 'dsh-team-choice',
                    'data-template-id': item.id,
                    'aria-checked': choice === item.id ? 'true' : 'false',
                    onClick: function () { pick(item.id) },
                  },
                    h('span', { className: 'dsh-team-choice-emoji', 'aria-hidden': 'true' }, item.emoji || '👥'),
                    h('span', { className: 'dsh-team-choice-text' },
                      h('span', { className: 'dsh-team-choice-name' }, item.name),
                      item.description ? h('span', { className: 'dsh-team-choice-desc' }, excerpt(item.description, 180)) : null)))
              })),
            chosen ? h('p', { className: 'dsh-bots-hint' }, t('addMemberHint')) : null,
            templates.phase === 'loading' ? h('p', { className: 'dsh-bots-hint', role: 'status' }, t('templatesLoading')) : null),
          h(Field, { label: t('teamName'), htmlFor: 'dsh-team-name', error: error },
            h('input', {
              id: 'dsh-team-name', ref: nameRef, className: 'dsh-bots-input', value: name, maxLength: MAX_NAME,
              placeholder: t('teamNamePlaceholder'), 'aria-invalid': error ? 'true' : undefined,
              onChange: function (event) { setName(event.target.value); setError(null) },
            })),
          chosen
            ? null
            : h(Field, { label: t('teamDescription'), htmlFor: 'dsh-team-description' },
              h('textarea', {
                id: 'dsh-team-description', className: 'dsh-bots-textarea dsh-team-textarea-sm', value: description,
                maxLength: 2000, placeholder: t('teamDescriptionPlaceholder'),
                onChange: function (event) { setDescription(event.target.value) },
              })),
          h('button', { type: 'submit', hidden: true, tabIndex: -1 })
        )
      )
    }

    function downloadJson(fileName, data) {
      const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
    }

    function TeamsView(props) {
      const t = props.t
      const lang = props.lang
      const catalog = props.catalog
      const showToast = props.showToast
      const [data, setData] = React.useState({ phase: 'loading', teams: [], error: null })
      const [templates, setTemplates] = React.useState({ phase: 'idle', list: [] })
      const [packs, setPacks] = React.useState({ phase: 'idle', list: [], error: null })
      const [projects, setProjects] = React.useState({ phase: 'idle', list: [], error: null })
      const [bits, setBits] = React.useState({ phase: 'loading', list: [], byId: {} })
      const [models, setModels] = React.useState(function () { return emptyModels('idle') })
      const [dialog, setDialog] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const aliveRef = React.useRef(true)
      const fileRef = React.useRef(null)

      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false }
      }, [])

      const tRef = React.useRef(t)
      tRef.current = t

      // Harness packs feed the card badges, the editor selects and the Harness dialog.
      const loadPacks = React.useCallback(function () {
        setPacks(function (previous) { return { phase: previous.list.length > 0 ? 'ready' : 'loading', list: previous.list, error: null } })
        return harnessApi.list().then(function (list) {
          if (aliveRef.current) setPacks({ phase: 'ready', list: list, error: null })
        }, function (error) {
          if (!aliveRef.current) return
          setPacks(function (previous) { return { phase: 'error', list: previous.list, error: requestErrorText(error, tRef.current) } })
        })
      }, [])
      React.useEffect(function () { loadPacks() }, [loadPacks])

      // Projects feed the card badges and the editor's project/shared fields (§12.4).
      const loadProjects = React.useCallback(function () {
        setProjects(function (previous) { return { phase: previous.list.length > 0 ? 'ready' : 'loading', list: previous.list, error: null } })
        return projectsApi.list().then(function (list) {
          if (aliveRef.current) setProjects({ phase: 'ready', list: list, error: null })
        }, function (error) {
          if (!aliveRef.current) return
          setProjects(function (previous) { return { phase: 'error', list: previous.list, error: requestErrorText(error, tRef.current) } })
        })
      }, [])
      React.useEffect(function () { loadProjects() }, [loadProjects])

      // Team members reference bits: the list feeds the member picker and display.
      const loadBits = React.useCallback(function () {
        setBits(function (previous) { return { phase: previous.list.length > 0 ? 'ready' : 'loading', list: previous.list, byId: previous.byId } })
        return api.list().then(function (payload) {
          if (aliveRef.current) setBits({ phase: 'ready', list: payload.bits, byId: payload.byId })
        }, function (error) {
          if (!aliveRef.current) return
          setBits(function (previous) { return { phase: 'error', list: previous.list, byId: previous.byId, error: requestErrorText(error, tRef.current) } })
        })
      }, [])
      React.useEffect(function () { loadBits() }, [loadBits])

      // Model catalog labels the members' read-only model/effort line.
      const loadModels = React.useCallback(function () {
        return api.models().then(function (payload) {
          if (aliveRef.current) setModels({ phase: 'ready', list: payload.list, byId: payload.byId, error: payload.error })
        }, function (error) {
          if (!aliveRef.current) return
          setModels(function (previous) { return { phase: 'error', list: previous.list, byId: previous.byId, error: requestErrorText(error, tRef.current) } })
        })
      }, [])
      React.useEffect(function () { loadModels() }, [loadModels])

      function packImported(pack) {
        setPacks(function (previous) {
          const exists = previous.list.some(function (item) { return item.id === pack.id })
          return {
            phase: 'ready',
            error: null,
            list: exists ? previous.list.map(function (item) { return item.id === pack.id ? pack : item }) : previous.list.concat([pack]),
          }
        })
        loadPacks()
      }

      async function createFromPack(pack) {
        const result = await teamsApi.fromPack(pack.id)
        upsert(result.team)
        loadBits()
        setDialog(null)
        showToast('success', t('teamFromPackCreated'))
        setOpenId(result.team.id)
      }

      /**
       * "Enviar pedido": the host starts the mission and returns the created
       * session; open it when the page can, otherwise the dialog shows its id.
       */
      async function sendRequest(team, prompt) {
        const result = await teamsApi.run(team.id, prompt)
        let opened = false
        if (result.sessionId && result.workspaceId && typeof props.openSession === 'function') {
          try {
            await Promise.resolve(props.openSession(result.sessionId))
            opened = true
          } catch (error) {
            opened = false
          }
        }
        if (!aliveRef.current) return { sessionId: result.sessionId, teamName: result.teamName, workspaceId: result.workspaceId, opened: false }
        // Opened: the page navigates away, so close the dialog. Otherwise the
        // dialog keeps the created session id visible (§8).
        if (opened) {
          setDialog(null)
          showToast('success', t('sendStarted'))
        }
        return { sessionId: result.sessionId, teamName: result.teamName, workspaceId: result.workspaceId, opened: opened }
      }

      const load = React.useCallback(function () {
        setData(function (previous) { return { phase: previous.teams.length > 0 ? 'ready' : 'loading', teams: previous.teams, error: null } })
        return teamsApi.list().then(function (teams) {
          if (aliveRef.current) setData({ phase: 'ready', teams: teams, error: null })
        }, function (error) {
          if (!aliveRef.current) return
          setData(function (previous) { return { phase: previous.teams.length > 0 ? 'ready' : 'error', teams: previous.teams, error: describeError(error) } })
        })
      }, [])

      React.useEffect(function () { load() }, [load])

      function loadTemplates() {
        if (templates.phase === 'ready' || templates.phase === 'loading') return
        setTemplates({ phase: 'loading', list: [] })
        teamsApi.templates().then(function (list) {
          if (aliveRef.current) setTemplates({ phase: 'ready', list: list })
        }, function () {
          if (aliveRef.current) setTemplates({ phase: 'error', list: [] })
        })
      }

      function openNew() {
        loadTemplates()
        setDialog({ kind: 'new' })
      }

      function upsert(team) {
        setData(function (previous) {
          const exists = previous.teams.some(function (item) { return item.id === team.id })
          return {
            phase: 'ready',
            error: null,
            teams: exists
              ? previous.teams.map(function (item) { return item.id === team.id ? team : item })
              : previous.teams.concat([team]),
          }
        })
      }

      // Saving a team with a project while unshared moves it to the Projects tab.
      function onTeamSaved(team) {
        upsert(team)
        if (teamIsProjectExclusive(team)) showToast('success', t('teamMovedToProject'))
      }

      async function createTeam(base) {
        const team = await teamsApi.create(base)
        upsert(team)
        setDialog(null)
        showToast('success', t('teamCreated'))
        setOpenId(team.id)
      }

      /** Template instantiation creates fresh bits before the team (§5.2). */
      async function createFromTemplate(input) {
        const result = await teamsApi.fromTemplate(input)
        upsert(result.team)
        loadBits()
        setDialog(null)
        showToast('success', t('teamCreated'))
        setOpenId(result.team.id)
      }

      async function duplicate(team) {
        try {
          const copy = JSON.parse(JSON.stringify(team))
          const suffix = ' ' + t('copySuffix')
          copy.name = team.name.slice(0, MAX_NAME - suffix.length) + suffix
          // At most one team per workspace should own its sessions: the copy never does.
          copy.bindWorkspace = false
          const created = await teamsApi.create(copy)
          upsert(created)
          showToast('success', t('teamDuplicated'))
        } catch (error) {
          showToast('error', t('failed') + ': ' + describeError(error))
        }
      }

      function exportTeam(team) {
        const slug = foldText(team.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'time'
        try {
          const payload = teamPayload(team)
          // Project ids are profile-local; the export keeps `shared` only (§12.1).
          delete payload.projectIds
          downloadJson(slug + '.team.json', { format: TEAM_EXPORT_FORMAT, version: 1, team: payload })
        } catch (error) {
          showToast('error', t('failed') + ': ' + describeError(error))
        }
      }

      function onImportFile(event) {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        file.text().then(function (text) {
          let parsed
          try { parsed = JSON.parse(text) } catch (error) { throw new Error(t('importInvalid')) }
          const raw = isObject(parsed) && isObject(parsed.team) ? parsed.team : parsed
          const team = normalizeTeamRecord(raw)
          if (!team || !asString(raw.name)) throw new Error(t('importInvalid'))
          // Project ids are profile-local; an imported team starts with no project (§12.1).
          team.projectIds = []
          return teamsApi.create(team)
        }).then(function (created) {
          upsert(created)
          loadBits()
          showToast('success', t('teamImported'))
        }, function (error) {
          showToast('error', describeError(error))
        })
      }

      async function confirmDelete() {
        if (!dialog || !dialog.team) return
        await teamsApi.remove(dialog.team.id)
        const id = dialog.team.id
        setData(function (previous) { return { phase: 'ready', error: null, teams: previous.teams.filter(function (item) { return item.id !== id }) } })
        setDialog(null)
        showToast('success', t('teamDeleted'))
      }

      const openTeam = openId ? data.teams.find(function (team) { return team.id === openId }) || null : null
      if (openTeam) {
        return h(TeamEditor, {
          key: openTeam.id,
          t: t,
          lang: lang,
          catalog: catalog,
          onRetryCatalog: props.onRetryCatalog,
          team: openTeam,
          teams: data.teams,
          projects: projects.list,
          packs: packs,
          bits: bits,
          models: models,
          onReloadPacks: loadPacks,
          showToast: showToast,
          onSaved: onTeamSaved,
          onClose: function () { setOpenId(null) },
        })
      }

      // An unshared team belongs to its project, so the Times tab lists only the
      // teams that are not exclusive to one (shared teams and project-less
      // teams). Hidden ones stay reachable through the Projects tab (§12.4).
      const listedTeams = data.teams.filter(function (team) { return !teamIsProjectExclusive(team) })
      const projectTeams = data.teams.length - listedTeams.length

      let body
      if (data.phase === 'loading') {
        body = h('p', { className: 'dsh-bots-hint', role: 'status' }, t('teamsLoading'))
      } else if (data.phase === 'error') {
        body = h('div', { className: 'dsh-bots-state dsh-bots-state-error' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(WarningIcon, { size: 28 })),
          h('p', { className: 'dsh-bots-state-title' }, t('teamsError')),
          data.error ? h('p', { className: 'dsh-bots-state-text' }, data.error) : null,
          h(Button, { variant: 'outline', onClick: load }, t('retry')))
      } else if (data.teams.length === 0) {
        body = h('div', { className: 'dsh-bots-state' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(TeamGlyph, { size: 40 })),
          h('p', { className: 'dsh-bots-state-title' }, t('teamsEmpty')),
          h('p', { className: 'dsh-bots-state-text' }, t('teamsEmptyHint')),
          h(Button, { variant: 'primary', onClick: openNew }, h(PlusIcon, { size: 14 }), t('newTeam')))
      } else if (listedTeams.length === 0) {
        body = h('div', { className: 'dsh-bots-state' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(ProjectsGlyph, { size: 40 })),
          h('p', { className: 'dsh-bots-state-title' }, t('teamsInProjectsTitle')),
          h('p', { className: 'dsh-bots-state-text' }, tf(t, 'teamsInProjectsHint', { n: projectTeams })),
          typeof props.onSelectTab === 'function'
            ? h(Button, { variant: 'primary', onClick: function () { props.onSelectTab('projects') } }, h(ProjectsGlyph, { size: 14 }), t('openProjectsTab'))
            : null)
      } else {
        body = h(React.Fragment, null,
          data.error ? h('div', { className: 'dsh-bots-banner', role: 'alert' },
            h('span', { className: 'dsh-bots-banner-text' }, t('teamsError') + ' ' + data.error),
            h(Button, { variant: 'outline', size: 'sm', onClick: load }, t('retry'))) : null,
          bits.phase === 'error'
            ? h('div', { className: 'dsh-bots-banner', role: 'alert' },
              h('span', { className: 'dsh-bots-banner-text' }, t('error') + ' ' + (bits.error || '')),
              h(Button, { variant: 'outline', size: 'sm', onClick: loadBits }, t('retry')))
            : null,
          projectTeams > 0
            ? h('div', { className: 'dsh-bots-banner' },
              h('span', { className: 'dsh-bots-banner-text' }, tf(t, 'teamsInProjectsNotice', { n: projectTeams })),
              typeof props.onSelectTab === 'function'
                ? h(Button, { variant: 'outline', size: 'sm', onClick: function () { props.onSelectTab('projects') } }, t('openProjectsTab'))
                : null)
            : null,
          h('ul', { className: 'dsh-bots-cards' }, listedTeams.map(function (team) {
            return h(TeamCard, {
              key: team.id, t: t, team: team, catalog: catalog, packs: packs, projects: projects.list,
              bitsById: bits.byId, models: models,
              onOpen: function (item) { setOpenId(item.id) },
              onSend: function (item) { setDialog({ kind: 'send', team: item }) },
              onDuplicate: duplicate,
              onExport: exportTeam,
              onDelete: function (item) { setDialog({ kind: 'delete', team: item }) },
            })
          })))
      }

      let dialogNode = null
      if (dialog && dialog.kind === 'new') {
        dialogNode = h(NewTeamDialog, {
          key: 'new', t: t, templates: templates,
          onCancel: function () { setDialog(null) },
          onCreate: createTeam,
          onCreateFromTemplate: createFromTemplate,
        })
      } else if (dialog && dialog.kind === 'delete') {
        dialogNode = h(ConfirmDialog, {
          key: 'delete', t: t, destructive: true,
          title: tf(t, 'deleteTeamTitle', { name: dialog.team.name }),
          description: t('deleteTeamBody'),
          confirmLabel: t('deleteTeam'),
          onCancel: function () { setDialog(null) },
          onConfirm: confirmDelete,
        })
      } else if (dialog && dialog.kind === 'send') {
        const current = data.teams.find(function (item) { return item.id === dialog.team.id }) || dialog.team
        dialogNode = h(SendRequestDialog, {
          key: 'send-' + current.id, t: t, team: current,
          onCancel: function () { setDialog(null) },
          onSubmit: sendRequest,
        })
      } else if (dialog && dialog.kind === 'harness') {
        dialogNode = h(HarnessDialog, {
          key: 'harness', t: t, packs: packs,
          onReload: loadPacks,
          onImported: packImported,
          onCreateTeam: createFromPack,
          onClose: function () { setDialog(null) },
        })
      }

      return h(React.Fragment, null,
        h('div', { className: 'dsh-bots-page' },
          h('div', { className: 'dsh-bots-inner' },
            h('header', { className: 'dsh-bots-head' },
              h('div', { className: 'dsh-bots-heading' },
                h('h1', { className: 'dsh-bots-title' }, t('title')),
                h('p', { className: 'dsh-bots-intro' }, t('teamsSubtitle'))),
              h('div', { className: 'dsh-bots-toolbar' },
                h(Button, {
                  variant: 'outline', title: t('harnessButtonHint'),
                  onClick: function () { loadPacks(); setDialog({ kind: 'harness' }) },
                }, h(PackageIcon, { size: 14 }), t('harnessButton')),
                h('input', { ref: fileRef, type: 'file', accept: 'application/json,.json', hidden: true, onChange: onImportFile }),
                h(Button, { variant: 'outline', title: t('importTeamHint'), onClick: function () { if (fileRef.current) fileRef.current.click() } }, h(UploadIcon, { size: 14 }), t('importTeam')),
                h(IconButton, { label: t('refresh'), onClick: function () { load(); loadPacks(); loadProjects(); loadBits(); loadModels() } }, h(RefreshIcon, { size: 16 })),
                h(Button, { variant: 'primary', onClick: openNew }, h(PlusIcon, { size: 14 }), t('newTeam')))),
            h('div', { className: 'dsh-bots-tabrow' }, props.tabs),
            h('div', { className: 'dsh-bots-body', 'aria-busy': data.phase === 'loading' ? 'true' : undefined }, body))),
        dialogNode
      )
    }

    /* ------------------------ projects layer ---------------------- */

    /** Project avatar: the project emoji over a tint of its colour. */
    function ProjectAvatar(props) {
      const project = props.project
      const size = props.size || 44
      return h('span', {
        className: 'dsh-bots-avatar',
        'aria-hidden': 'true',
        style: { width: size, height: size, fontSize: Math.round(size / 2), background: hexAlpha(project.color, 0.16) },
      }, project.emoji || PROJECT_EMOJI)
    }

    /** Project card of the Projects list (CONTRACT.md §12.4). */
    function ProjectCard(props) {
      const t = props.t
      const project = props.project
      const counts = props.counts
      const description = excerpt(project.description, 220)
      return h('li', { className: 'dsh-bots-card' },
        h('div', { className: 'dsh-bots-card-head' },
          h(ProjectAvatar, { project: project }),
          h('div', { className: 'dsh-bots-card-titles' },
            h('div', { className: 'dsh-bots-name-row' },
              h('h3', { className: 'dsh-bots-name', title: project.name }, project.name)),
            h('p', { className: 'dsh-bots-role' }, tf(t, 'projectTeamsCount', { n: counts.teams })))),
        h('p', { className: 'dsh-bots-persona' + (description ? '' : ' dsh-bots-persona-empty'), title: description || undefined }, description || t('noDescription')),
        counts.shared > 0
          ? h('div', { className: 'dsh-team-badges' },
            h(Badge, { dot: false, tone: 'info', label: tf(t, 'projectSharedCount', { n: counts.shared }) }))
          : null,
        h('div', { className: 'dsh-bots-actions' },
          h(Button, { variant: 'primary', size: 'sm', onClick: function () { props.onOpen(project) } }, h(ProjectsGlyph, { size: 14 }), t('openProject')),
          h(IconButton, { label: t('editProject'), className: 'dsh-bots-icon-button-sm', onClick: function () { props.onEdit(project) } }, h(EditIcon, { size: 14 })),
          h('span', { className: 'dsh-bots-actions-grow' }),
          h(Button, { variant: 'ghost', size: 'sm', className: 'dsh-bots-button-danger', onClick: function () { props.onDelete(project) } }, h(TrashIcon, { size: 14 }), t('deleteProject')))
      )
    }

    /** Create/edit project dialog: name, description, emoji and a colour swatch (§12.4). */
    function ProjectDialog(props) {
      const t = props.t
      const project = props.project || null
      const nameRef = React.useRef(null)
      const [name, setName] = React.useState(project ? project.name : '')
      const [description, setDescription] = React.useState(project ? project.description : '')
      const [emoji, setEmoji] = React.useState(project ? project.emoji : PROJECT_EMOJI)
      const [color, setColor] = React.useState(project ? project.color : PROJECT_COLOR)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (busy) return
        const trimmed = name.trim()
        if (!trimmed) {
          setError(t('projectNameRequired'))
          if (nameRef.current) nameRef.current.focus()
          return
        }
        setBusy(true)
        setError(null)
        Promise.resolve(props.onSubmit({ name: trimmed, description: description, emoji: emoji, color: color })).catch(function (reason) {
          setBusy(false)
          setError(describeError(reason))
        })
      }

      const footer = [
        h('button', { key: 'cancel', type: 'button', className: 'dsh-bots-button dsh-bots-button-outline', disabled: busy, onClick: props.onCancel }, t('cancel')),
        h('button', {
          key: 'ok', type: 'button', className: 'dsh-bots-button dsh-bots-button-primary',
          disabled: busy, 'aria-busy': busy ? 'true' : undefined, onClick: submit,
        }, busy ? t('saving') : (project ? t('save') : t('createProject'))),
      ]
      return h(Modal, {
        t: t, title: project ? t('editProject') : t('newProject'), wide: true,
        initialFocusRef: nameRef, onClose: props.onCancel, dismissDisabled: busy, footer: footer,
      },
        h('form', { onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: 14 } },
          h(Field, { label: t('projectName'), htmlFor: 'dsh-project-name', error: error },
            h('input', {
              id: 'dsh-project-name', ref: nameRef, className: 'dsh-bots-input', value: name, maxLength: MAX_NAME,
              placeholder: t('projectNamePlaceholder'), 'aria-invalid': error ? 'true' : undefined,
              onChange: function (event) { setName(event.target.value); setError(null) },
            })),
          h(Field, { label: t('projectDescription'), htmlFor: 'dsh-project-description' },
            h('textarea', {
              id: 'dsh-project-description', className: 'dsh-bots-textarea dsh-team-textarea-sm', value: description,
              maxLength: 2000, placeholder: t('projectDescriptionPlaceholder'),
              onChange: function (event) { setDescription(event.target.value) },
            })),
          h('div', { className: 'dsh-bots-row' },
            h(Field, { label: t('projectEmoji'), htmlFor: 'dsh-project-emoji' },
              h('input', { id: 'dsh-project-emoji', className: 'dsh-bots-input', style: { width: 64, textAlign: 'center' }, value: emoji, maxLength: 8, onChange: function (event) { setEmoji(event.target.value) } })),
            h(Field, { label: t('projectColor'), htmlFor: 'dsh-project-color', grow: true },
              h('div', { className: 'dsh-bots-palette', id: 'dsh-project-color' }, GROUP_COLORS.map(function (swatch) {
                return h('button', {
                  key: swatch, type: 'button', className: 'dsh-bots-swatch', style: { backgroundColor: swatch },
                  'aria-pressed': color === swatch ? 'true' : 'false', 'aria-label': swatch,
                  onClick: function () { setColor(swatch) },
                })
              })))),
          h('button', { type: 'submit', hidden: true, tabIndex: -1 })
        )
      )
    }

    /** "Adicionar times": checkbox picker over every team; only changed memberships are patched. */
    function ProjectTeamsDialog(props) {
      const t = props.t
      const project = props.project
      const teams = Array.isArray(props.teams) ? props.teams : []
      const projects = Array.isArray(props.projects) ? props.projects : []
      const [selected, setSelected] = React.useState(function () {
        const map = {}
        teams.forEach(function (team) { if (team.projectIds.indexOf(project.id) >= 0) map[team.id] = true })
        return map
      })

      function otherProjectOf(team) {
        for (let index = 0; index < team.projectIds.length; index += 1) {
          if (team.projectIds[index] !== project.id) return projectLabel(projects, team.projectIds[index], t)
        }
        return ''
      }

      function toggle(team, checked) {
        setSelected(function (previous) {
          const next = Object.assign({}, previous)
          if (checked) next[team.id] = true
          else delete next[team.id]
          return next
        })
      }

      const ids = Object.keys(selected).filter(function (id) { return selected[id] })
      const footer = [
        h('button', { key: 'cancel', type: 'button', className: 'dsh-bots-button dsh-bots-button-outline', onClick: props.onCancel }, t('cancel')),
        h('button', { key: 'ok', type: 'button', className: 'dsh-bots-button dsh-bots-button-primary', onClick: function () { props.onConfirm(ids) } }, t('addTeamsConfirm')),
      ]
      let body
      if (teams.length === 0) {
        body = h('p', { className: 'dsh-bots-hint' }, t('teamsEmpty'))
      } else {
        body = h('div', { className: 'dsh-project-picker' }, teams.map(function (team) {
          const inProject = team.projectIds.indexOf(project.id) >= 0
          // A non-shared team that already belongs to another project cannot be added here (§12.4).
          const blocked = !inProject && team.shared !== true && team.projectIds.length > 0
          return h(Checkbox, {
            key: team.id,
            checked: selected[team.id] === true,
            disabled: blocked,
            label: h('span', { className: 'dsh-project-picker-label' },
              h('span', null, (team.emoji ? team.emoji + ' ' : '') + team.name),
              blocked ? h('span', { className: 'dsh-project-picker-note' }, t('projectTeamNotShared') + ' (' + otherProjectOf(team) + ')') : null),
            onChange: function (checked) { toggle(team, checked) },
          })
        }))
      }
      return h(Modal, { t: t, title: t('addTeamsTitle'), wide: true, onClose: props.onCancel, footer: footer },
        h('p', { className: 'dsh-bots-hint' }, t('addTeamsHint')),
        body)
    }

    /** Projects tab: list of projects and the project detail with its teams (§12.4). */
    function ProjectsView(props) {
      const t = props.t
      const lang = props.lang
      const catalog = props.catalog
      const showToast = props.showToast
      const [data, setData] = React.useState({ phase: 'loading', projects: [], teams: [], error: null })
      const [templates, setTemplates] = React.useState({ phase: 'idle', list: [] })
      const [packs, setPacks] = React.useState({ phase: 'idle', list: [], error: null })
      const [bits, setBits] = React.useState({ phase: 'loading', list: [], byId: {} })
      const [models, setModels] = React.useState(function () { return emptyModels('idle') })
      const [dialog, setDialog] = React.useState(null)
      const [openProjectId, setOpenProjectId] = React.useState(null)
      const [openTeamId, setOpenTeamId] = React.useState(null)
      const aliveRef = React.useRef(true)

      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false }
      }, [])

      // Same optional side data as the Teams tab: pack badges and team templates.
      const tRef = React.useRef(t)
      tRef.current = t
      const loadPacks = React.useCallback(function () {
        setPacks(function (previous) { return { phase: previous.list.length > 0 ? 'ready' : 'loading', list: previous.list, error: null } })
        return harnessApi.list().then(function (list) {
          if (aliveRef.current) setPacks({ phase: 'ready', list: list, error: null })
        }, function (error) {
          if (!aliveRef.current) return
          setPacks(function (previous) { return { phase: 'error', list: previous.list, error: requestErrorText(error, tRef.current) } })
        })
      }, [])
      React.useEffect(function () { loadPacks() }, [loadPacks])

      // Member references and read-only routes: bits + the model catalog labels.
      const loadBits = React.useCallback(function () {
        setBits(function (previous) { return { phase: previous.list.length > 0 ? 'ready' : 'loading', list: previous.list, byId: previous.byId } })
        return api.list().then(function (payload) {
          if (aliveRef.current) setBits({ phase: 'ready', list: payload.bits, byId: payload.byId })
        }, function (error) {
          if (!aliveRef.current) return
          setBits(function (previous) { return { phase: 'error', list: previous.list, byId: previous.byId, error: requestErrorText(error, tRef.current) } })
        })
      }, [])
      React.useEffect(function () { loadBits() }, [loadBits])

      const loadModels = React.useCallback(function () {
        return api.models().then(function (payload) {
          if (aliveRef.current) setModels({ phase: 'ready', list: payload.list, byId: payload.byId, error: payload.error })
        }, function (error) {
          if (!aliveRef.current) return
          setModels(function (previous) { return { phase: 'error', list: previous.list, byId: previous.byId, error: requestErrorText(error, tRef.current) } })
        })
      }, [])
      React.useEffect(function () { loadModels() }, [loadModels])

      const load = React.useCallback(function () {
        setData(function (previous) {
          return { phase: previous.projects.length > 0 ? 'ready' : 'loading', projects: previous.projects, teams: previous.teams, error: null }
        })
        return Promise.all([projectsApi.list(), teamsApi.list()]).then(function (result) {
          if (aliveRef.current) setData({ phase: 'ready', projects: result[0], teams: result[1], error: null })
        }, function (error) {
          if (!aliveRef.current) return
          setData(function (previous) {
            return {
              phase: previous.projects.length > 0 ? 'ready' : 'error',
              projects: previous.projects,
              teams: previous.teams,
              error: requestErrorText(error, tRef.current),
            }
          })
        })
      }, [])
      React.useEffect(function () { load() }, [load])

      function loadTemplates() {
        if (templates.phase === 'ready' || templates.phase === 'loading') return
        setTemplates({ phase: 'loading', list: [] })
        teamsApi.templates().then(function (list) {
          if (aliveRef.current) setTemplates({ phase: 'ready', list: list })
        }, function () {
          if (aliveRef.current) setTemplates({ phase: 'error', list: [] })
        })
      }

      const teams = data.teams
      const projects = data.projects
      const projectsById = React.useMemo(function () { return indexBy(projects) }, [projects])
      const detailProject = openProjectId ? projectsById[openProjectId] || null : null
      const openTeam = openTeamId ? teams.find(function (team) { return team.id === openTeamId }) || null : null

      function teamsOf(project) {
        return teams.filter(function (team) { return team.projectIds.indexOf(project.id) >= 0 })
      }
      function countsOf(project) {
        const list = teamsOf(project)
        return {
          teams: list.length,
          shared: list.filter(function (team) { return team.shared === true }).length,
        }
      }

      function upsertTeam(team) {
        setData(function (previous) {
          const exists = previous.teams.some(function (item) { return item.id === team.id })
          return {
            phase: 'ready',
            projects: previous.projects,
            error: null,
            teams: exists
              ? previous.teams.map(function (item) { return item.id === team.id ? team : item })
              : previous.teams.concat([team]),
          }
        })
      }

      function openNewProject() { setDialog({ kind: 'project', project: null }) }
      function openEditProject(project) { setDialog({ kind: 'project', project: project }) }
      function openDeleteProject(project) { setDialog({ kind: 'deleteProject', project: project }) }
      function openNewTeam(project) { loadTemplates(); setDialog({ kind: 'newTeam', project: project }) }
      function openAddTeams(project) { setDialog({ kind: 'teams', project: project }) }

      async function saveProject(values) {
        const editing = dialog && dialog.project ? dialog.project : null
        if (editing) await projectsApi.update(editing.id, values)
        else await projectsApi.create(values)
        setDialog(null)
        showToast('success', t(editing ? 'projectSaved' : 'projectCreated'))
        await load()
      }

      async function confirmDeleteProject() {
        const project = dialog && dialog.project
        if (!project) return
        const result = await projectsApi.remove(project.id)
        setOpenProjectId(null)
        setDialog(null)
        await load()
        // Teams are detached, never deleted; report how many when the host says so (§12.3).
        const detached = result.detachedTeams > 0 ? ' ' + tf(t, 'projectTeamsDetached', { n: result.detachedTeams }) : ''
        showToast('success', t('projectDeleted') + detached)
      }

      async function createTeam(base) {
        const team = await teamsApi.create(base)
        upsertTeam(team)
        setDialog(null)
        showToast('success', t('teamCreated'))
        await load()
      }

      /** Template instantiation creates fresh bits before the team (§5.2). */
      async function createFromTemplate(input) {
        const result = await teamsApi.fromTemplate(input)
        upsertTeam(result.team)
        setDialog(null)
        showToast('success', t('teamCreated'))
        await Promise.all([load(), loadBits()])
      }

      async function applyTeams(project, selectedIds) {
        try {
          const changed = teams.filter(function (team) {
            return (team.projectIds.indexOf(project.id) >= 0) !== (selectedIds.indexOf(team.id) >= 0)
          })
          for (let index = 0; index < changed.length; index += 1) {
            const team = changed[index]
            const next = selectedIds.indexOf(team.id) >= 0
              ? team.projectIds.concat([project.id])
              : team.projectIds.filter(function (id) { return id !== project.id })
            await teamsApi.update(team.id, Object.assign({}, team, { projectIds: next }))
          }
          setDialog(null)
          await load()
        } catch (error) {
          showToast('error', t('saveFailed') + ': ' + describeError(error))
          await load()
        }
      }

      async function detachTeam(project, team) {
        if (!project) return
        try {
          await teamsApi.update(team.id, Object.assign({}, team, {
            projectIds: team.projectIds.filter(function (id) { return id !== project.id }),
          }))
          showToast('success', t('removeFromProjectDone'))
          await load()
        } catch (error) {
          showToast('error', t('saveFailed') + ': ' + describeError(error))
        }
      }

      async function confirmDeleteTeam() {
        const team = dialog && dialog.team
        if (!team) return
        await teamsApi.remove(team.id)
        setDialog(null)
        showToast('success', t('teamDeleted'))
        await load()
      }

      async function duplicate(team) {
        try {
          const copy = JSON.parse(JSON.stringify(team))
          const suffix = ' ' + t('copySuffix')
          copy.name = team.name.slice(0, MAX_NAME - suffix.length) + suffix
          copy.bindWorkspace = false
          const created = await teamsApi.create(copy)
          upsertTeam(created)
          showToast('success', t('teamDuplicated'))
        } catch (error) {
          showToast('error', t('failed') + ': ' + describeError(error))
        }
      }

      function exportTeam(team) {
        const slug = foldText(team.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'time'
        try {
          const payload = teamPayload(team)
          delete payload.projectIds
          downloadJson(slug + '.team.json', { format: TEAM_EXPORT_FORMAT, version: 1, team: payload })
        } catch (error) {
          showToast('error', t('failed') + ': ' + describeError(error))
        }
      }

      async function sendRequest(team, prompt) {
        const result = await teamsApi.run(team.id, prompt)
        let opened = false
        if (result.sessionId && result.workspaceId && typeof props.openSession === 'function') {
          try {
            await Promise.resolve(props.openSession(result.sessionId))
            opened = true
          } catch (error) {
            opened = false
          }
        }
        if (!aliveRef.current) return { sessionId: result.sessionId, teamName: result.teamName, workspaceId: result.workspaceId, opened: false }
        // Opened: the page navigates away, so close the dialog. Otherwise the
        // dialog keeps the created session id visible (§8).
        if (opened) {
          setDialog(null)
          showToast('success', t('sendStarted'))
        }
        return { sessionId: result.sessionId, teamName: result.teamName, workspaceId: result.workspaceId, opened: opened }
      }

      // Opening a card renders the same TeamEditor inside the Projects tab (§12.4).
      if (openTeam) {
        return h(TeamEditor, {
          key: openTeam.id,
          t: t,
          lang: lang,
          catalog: catalog,
          onRetryCatalog: props.onRetryCatalog,
          team: openTeam,
          teams: teams,
          projects: projects,
          packs: packs,
          bits: bits,
          models: models,
          onReloadPacks: loadPacks,
          showToast: showToast,
          onSaved: upsertTeam,
          backLabel: t('backToProjects'),
          onClose: function () { setOpenTeamId(null) },
        })
      }

      let dialogNode = null
      if (dialog && dialog.kind === 'project') {
        dialogNode = h(ProjectDialog, {
          key: 'project', t: t, project: dialog.project,
          onCancel: function () { setDialog(null) },
          onSubmit: saveProject,
        })
      } else if (dialog && dialog.kind === 'deleteProject') {
        dialogNode = h(ConfirmDialog, {
          key: 'deleteProject', t: t, destructive: true,
          title: tf(t, 'deleteProjectTitle', { name: dialog.project.name }),
          description: t('deleteProjectBody'),
          confirmLabel: t('deleteProject'),
          onCancel: function () { setDialog(null) },
          onConfirm: confirmDeleteProject,
        })
      } else if (dialog && dialog.kind === 'newTeam') {
        dialogNode = h(NewTeamDialog, {
          key: 'newTeam', t: t, templates: templates, projectId: dialog.project.id,
          onCancel: function () { setDialog(null) },
          onCreate: createTeam,
          onCreateFromTemplate: createFromTemplate,
        })
      } else if (dialog && dialog.kind === 'teams') {
        dialogNode = h(ProjectTeamsDialog, {
          key: 'teams', t: t, project: dialog.project, teams: teams, projects: projects,
          onCancel: function () { setDialog(null) },
          onConfirm: function (ids) { return applyTeams(dialog.project, ids) },
        })
      } else if (dialog && dialog.kind === 'deleteTeam') {
        dialogNode = h(ConfirmDialog, {
          key: 'deleteTeam', t: t, destructive: true,
          title: tf(t, 'deleteTeamTitle', { name: dialog.team.name }),
          description: t('deleteTeamBody'),
          confirmLabel: t('deleteTeam'),
          onCancel: function () { setDialog(null) },
          onConfirm: confirmDeleteTeam,
        })
      } else if (dialog && dialog.kind === 'send') {
        const current = teams.find(function (item) { return item.id === dialog.team.id }) || dialog.team
        dialogNode = h(SendRequestDialog, {
          key: 'send-' + current.id, t: t, team: current,
          onCancel: function () { setDialog(null) },
          onSubmit: sendRequest,
        })
      }

      if (detailProject) {
        const projectTeams = teamsOf(detailProject)
        const counts = countsOf(detailProject)
        const description = excerpt(detailProject.description, 400)
        let projectBody
        if (projectTeams.length === 0) {
          projectBody = h('div', { className: 'dsh-bots-state' },
            h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(ProjectsGlyph, { size: 40 })),
            h('p', { className: 'dsh-bots-state-title' }, t('noProjectTeams')),
            h('p', { className: 'dsh-bots-state-text' }, t('noProjectTeamsHint')),
            h(Button, { variant: 'primary', onClick: function () { openAddTeams(detailProject) } }, h(PlusIcon, { size: 14 }), t('addExistingTeams')))
        } else {
          projectBody = h('ul', { className: 'dsh-bots-cards' }, projectTeams.map(function (team) {
            return h(TeamCard, {
              key: team.id, t: t, team: team, catalog: catalog, packs: packs, projects: projects,
              bitsById: bits.byId, models: models,
              onOpen: function (item) { setOpenTeamId(item.id) },
              onSend: function (item) { setDialog({ kind: 'send', team: item }) },
              onDuplicate: duplicate,
              onExport: exportTeam,
              onDetach: function (item) { return detachTeam(detailProject, item) },
              onDelete: function (item) { setDialog({ kind: 'deleteTeam', team: item }) },
            })
          }))
        }
        return h(React.Fragment, null,
          h('div', { className: 'dsh-bots-page' },
            h('div', { className: 'dsh-bots-inner' },
              h('header', { className: 'dsh-bots-head' },
                h('div', { className: 'dsh-project-head' },
                  h(IconButton, { label: t('backToProjects'), onClick: function () { setOpenProjectId(null) } }, h(ArrowLeftIcon, { size: 16 })),
                  h(ProjectAvatar, { project: detailProject, size: 48 }),
                  h('div', { className: 'dsh-project-heading' },
                    h('h1', { className: 'dsh-project-name', title: detailProject.name }, detailProject.name),
                    description ? h('p', { className: 'dsh-project-desc' }, description) : null,
                    h('div', { className: 'dsh-project-meta' },
                      h(Badge, { dot: false, tone: 'info', label: tf(t, 'projectTeamsCount', { n: counts.teams }) }),
                      counts.shared > 0 ? h(Badge, { dot: false, label: tf(t, 'projectSharedCount', { n: counts.shared }) }) : null))),
                h('div', { className: 'dsh-bots-toolbar' },
                  h(Button, { variant: 'primary', onClick: function () { openNewTeam(detailProject) } }, h(PlusIcon, { size: 14 }), t('projectNewTeam')),
                  h(Button, { variant: 'outline', onClick: function () { openAddTeams(detailProject) } }, h(TeamGlyph, { size: 14 }), t('addExistingTeams')),
                  h(IconButton, { label: t('editProject'), onClick: function () { openEditProject(detailProject) } }, h(EditIcon, { size: 16 })),
                  h(IconButton, { label: t('deleteProject'), onClick: function () { openDeleteProject(detailProject) } }, h(TrashIcon, { size: 16 })))),
              h('div', { className: 'dsh-bots-tabrow' }, props.tabs),
              h('div', { className: 'dsh-bots-body' }, projectBody))),
          dialogNode)
      }

      let body
      if (data.phase === 'loading') {
        body = h('p', { className: 'dsh-bots-hint', role: 'status' }, t('projectsLoading'))
      } else if (data.phase === 'error') {
        body = h('div', { className: 'dsh-bots-state dsh-bots-state-error' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(WarningIcon, { size: 28 })),
          h('p', { className: 'dsh-bots-state-title' }, t('projectsError')),
          data.error ? h('p', { className: 'dsh-bots-state-text' }, data.error) : null,
          h(Button, { variant: 'outline', onClick: load }, t('retry')))
      } else if (projects.length === 0) {
        body = h('div', { className: 'dsh-bots-state' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(ProjectsGlyph, { size: 40 })),
          h('p', { className: 'dsh-bots-state-title' }, t('projectsEmpty')),
          h('p', { className: 'dsh-bots-state-text' }, t('projectsEmptyHint')),
          h(Button, { variant: 'primary', onClick: openNewProject }, h(PlusIcon, { size: 14 }), t('newProject')))
      } else {
        body = h(React.Fragment, null,
          data.error ? h('div', { className: 'dsh-bots-banner', role: 'alert' },
            h('span', { className: 'dsh-bots-banner-text' }, t('projectsError') + ' ' + data.error),
            h(Button, { variant: 'outline', size: 'sm', onClick: load }, t('retry'))) : null,
          h('ul', { className: 'dsh-bots-cards' }, projects.map(function (project) {
            return h(ProjectCard, {
              key: project.id, t: t, project: project, counts: countsOf(project),
              onOpen: function (item) { setOpenProjectId(item.id) },
              onEdit: openEditProject,
              onDelete: openDeleteProject,
            })
          })))
      }

      return h(React.Fragment, null,
        h('div', { className: 'dsh-bots-page' },
          h('div', { className: 'dsh-bots-inner' },
            h('header', { className: 'dsh-bots-head' },
              h('div', { className: 'dsh-bots-heading' },
                h('h1', { className: 'dsh-bots-title' }, t('title')),
                h('p', { className: 'dsh-bots-intro' }, t('projectsSubtitle'))),
              h('div', { className: 'dsh-bots-toolbar' },
                h(IconButton, { label: t('refresh'), onClick: function () { load(); loadPacks(); loadBits(); loadModels() } }, h(RefreshIcon, { size: 16 })),
                h(Button, { variant: 'primary', onClick: openNewProject }, h(PlusIcon, { size: 14 }), t('newProject')))),
            h('div', { className: 'dsh-bots-tabrow' }, props.tabs),
            h('div', { className: 'dsh-bots-body', 'aria-busy': data.phase === 'loading' ? 'true' : undefined }, body))),
        dialogNode)
    }

    /* -------------------------- editor ---------------------------- */

    function draftOf(team) {
      return {
        name: team.name,
        description: team.description,
        emoji: team.emoji,
        color: team.color,
        workspaceDir: team.workspaceDir || '',
        members: team.members,
        flow: team.flow,
        lead: team.lead || null,
        harness: team.harness || null,
        bindWorkspace: team.bindWorkspace === true,
        rules: asString(team.rules),
        skills: Array.isArray(team.skills) ? team.skills : [],
        entry: Array.isArray(team.entry) ? team.entry : [],
        shared: team.shared === true,
        projectIds: Array.isArray(team.projectIds) ? team.projectIds : [],
      }
    }

    function isTypingTarget(target) {
      if (!target || !target.tagName) return false
      const tag = target.tagName.toLowerCase()
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true
    }

    const EMPTY_SELECTION = { nodes: [], edge: null, member: null }

    function readPanels() {
      try {
        const value = JSON.parse(window.localStorage.getItem(PANELS_STORAGE_KEY) || 'null')
        if (isObject(value)) return { side: value.side !== false, inspector: value.inspector !== false }
      } catch (error) { /* default below */ }
      return { side: true, inspector: true }
    }

    function TeamEditor(props) {
      const t = props.t
      const lang = props.lang
      const catalog = props.catalog
      const showToast = props.showToast
      // "Voltar" returns to the tab the editor was opened from (Times by default, Projects inside a project).
      const backLabel = asString(props.backLabel) || t('backToTeams')
      const history = useFlowHistory(draftOf(props.team))
      const draft = history.draft
      const [savedJson, setSavedJson] = React.useState(function () { return canonicalJson(draftOf(props.team)) })
      const [selection, setSelectionState] = React.useState(EMPTY_SELECTION)
      const [view, setView] = React.useState({ x: 40, y: 40, k: 1 })
      const [overlay, setOverlay] = React.useState(null)
      const [panning, setPanning] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [dialog, setDialog] = React.useState(null)
      const [focusRequest, setFocusRequest] = React.useState(null)
      const [panels, setPanelsState] = React.useState(readPanels)
      function setPanels(next) {
        setPanelsState(next)
        try { window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(next)) } catch (error) { /* best effort */ }
      }
      const canvasRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const interactionRef = React.useRef(null)
      const fittedRef = React.useRef(false)
      const viewRef = React.useRef(view)
      const draftRef = React.useRef(draft)
      const selectionRef = React.useRef(selection)
      viewRef.current = view
      draftRef.current = draft
      selectionRef.current = selection

      const dirty = React.useMemo(function () { return canonicalJson(draft) !== savedJson }, [draft, savedJson])
      const membersById = React.useMemo(function () { return indexBy(draft.members) }, [draft.members])
      const nodesById = React.useMemo(function () { return indexBy(draft.flow.nodes) }, [draft.flow.nodes])
      const allTeams = Array.isArray(props.teams) ? props.teams : []
      const teamsById = React.useMemo(function () { return indexBy(allTeams) }, [allTeams])
      const otherTeams = allTeams.filter(function (item) { return item.id !== props.team.id })
      const packs = props.packs || { phase: 'idle', list: [], error: null }
      const pack = findPack(packs, draft.harness)
      // Member references resolve through the bits list; the model catalog labels routes.
      const bitsState = props.bits || { phase: 'loading', list: [], byId: {} }
      const bitsById = bitsState.byId || {}
      const models = props.models || emptyModels('idle')

      // Selections may point at things an undo removed: keep only live ids.
      const liveSelection = React.useMemo(function () {
        const nodes = selection.nodes.filter(function (id) { return !!nodesById[id] })
        const edge = selection.edge && draft.flow.edges.some(function (item) { return item.id === selection.edge }) ? selection.edge : null
        const member = selection.member && membersById[selection.member] ? selection.member : null
        return { nodes: nodes, edge: edge, member: member }
      }, [selection, nodesById, membersById, draft.flow.edges])

      // Each inspector starts at its top: the panel would otherwise keep the previous scroll offset.
      const inspectorRef = React.useRef(null)
      const inspectorKey = liveSelection.member
        ? 'member:' + liveSelection.member
        : (liveSelection.edge ? 'edge:' + liveSelection.edge : (liveSelection.nodes.length === 1 ? 'node:' + liveSelection.nodes[0] : (liveSelection.nodes.length > 1 ? 'nodes' : 'team')))
      React.useEffect(function () {
        if (inspectorRef.current) inspectorRef.current.scrollTop = 0
      }, [inspectorKey])

      const select = React.useCallback(function (next, focusNodeId) {
        setSelectionState(next)
        setFocusRequest(focusNodeId ? { nodeId: focusNodeId, seq: Date.now() } : null)
        if (focusNodeId) {
          setPanelsState(function (current) { return current.inspector ? current : { side: current.side, inspector: true } })
        }
      }, [])

      /* ----- view helpers ----- */

      function canvasRect() {
        const element = canvasRef.current
        return element ? element.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }
      }

      function toCanvas(clientX, clientY) {
        const rect = canvasRect()
        const current = viewRef.current
        return { x: (clientX - rect.left - current.x) / current.k, y: (clientY - rect.top - current.y) / current.k }
      }

      const fitView = React.useCallback(function (readable) {
        const element = canvasRef.current
        if (!element) return false
        const width = element.clientWidth
        const height = element.clientHeight
        if (width < 40 || height < 40) return false
        const bounds = flowBounds(draftRef.current.flow.nodes)
        if (!bounds) {
          setView({ x: Math.round(width / 2 - 92), y: Math.round(height / 2 - 24), k: 1 })
          return true
        }
        const pad = 56
        const k = clamp(Math.min((width - pad * 2) / bounds.w, (height - pad * 2) / bounds.h), ZOOM_MIN, 1)
        if (readable === true && k < READABLE_ZOOM) {
          // Too small to read: open at a legible zoom anchored at the flow start (top-left).
          setView({ k: READABLE_ZOOM, x: 32 - bounds.x * READABLE_ZOOM, y: 32 - bounds.y * READABLE_ZOOM })
          return true
        }
        setView({ k: k, x: (width - bounds.w * k) / 2 - bounds.x * k, y: (height - bounds.h * k) / 2 - bounds.y * k })
        return true
      }, [])

      function zoomAt(factor, clientX, clientY) {
        const rect = canvasRect()
        const px = clientX === undefined ? rect.width / 2 : clientX - rect.left
        const py = clientY === undefined ? rect.height / 2 : clientY - rect.top
        setView(function (current) {
          const k = clamp(current.k * factor, ZOOM_MIN, ZOOM_MAX)
          if (k === current.k) return current
          return { k: k, x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k) }
        })
      }

      React.useLayoutEffect(function () {
        if (!fittedRef.current && fitView(true)) fittedRef.current = true
        const element = canvasRef.current
        if (!element || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(function () {
          if (!fittedRef.current && fitView(true)) fittedRef.current = true
        })
        observer.observe(element)
        return function () { observer.disconnect() }
      }, [fitView])

      // Wheel: pan by default, zoom with Ctrl/Cmd (also trackpad pinch). Non-passive to prevent page scroll.
      React.useEffect(function () {
        const element = canvasRef.current
        if (!element) return undefined
        function onWheel(event) {
          event.preventDefault()
          if (event.ctrlKey || event.metaKey) {
            zoomAt(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0022)), event.clientX, event.clientY)
          } else {
            const scale = event.deltaMode === 1 ? 16 : 1
            const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * scale
            const dy = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * scale
            setView(function (current) { return { k: current.k, x: current.x - dx, y: current.y - dy } })
          }
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return function () { element.removeEventListener('wheel', onWheel) }
      }, [])

      /* ----- node creation ----- */

      function createNode(type, memberId, point) {
        const current = draftRef.current
        const size = NODE_SIZE[type] || NODE_SIZE.step
        let x = snap(point.x - size[0] / 2)
        let y = snap(point.y - size[1] / 2)
        for (let guard = 0; guard < 50 && current.flow.nodes.some(function (node) { return node.x === x && node.y === y }); guard += 1) {
          x += 24
          y += 24
        }
        const member = memberId ? membersById[memberId] : null
        const node = { id: freshId('n', indexBy(current.flow.nodes)), type: type, x: x, y: y, label: t(TYPE_DEFAULT_KEY[type] || 'nodeStepDefault'), detail: '' }
        if (type === 'step') node.memberId = member ? member.id : null
        if (type === 'team') node.teamRef = null
        if (type === 'group' || type === 'note') {
          node.w = size[0]
          node.h = size[1]
        }
        if (type === 'group') node.color = GROUP_COLORS[current.flow.nodes.filter(function (item) { return item.type === 'group' }).length % GROUP_COLORS.length]
        history.commit(function (previous) { return addNodeTo(previous, node) })
        select({ nodes: [node.id], edge: null, member: null }, node.id)
      }

      function createAtCenter(type, memberId) {
        const rect = canvasRect()
        createNode(type, memberId, toCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2))
      }

      /* ----- selection operations ----- */

      function deleteSelection() {
        const current = liveSelection
        if (current.member) {
          requestRemoveMember(current.member)
          return
        }
        if (current.nodes.length === 0 && !current.edge) return
        history.commit(function (previous) { return removeFromFlow(previous, current.nodes, current.edge ? [current.edge] : []) })
        select(EMPTY_SELECTION)
      }

      function duplicateSelection() {
        const ids = liveSelection.nodes
        if (ids.length === 0) return
        let created = []
        history.commit(function (previous) {
          const result = duplicateNodes(previous, ids)
          created = result.ids
          return result.draft
        })
        // commit runs the updater synchronously inside setState batching; read ids after.
        setTimeout(function () { if (created.length) select({ nodes: created, edge: null, member: null }) }, 0)
      }

      function nudge(dx, dy) {
        const ids = liveSelection.nodes
        if (ids.length === 0) return
        const origins = {}
        draftRef.current.flow.nodes.forEach(function (node) { if (ids.indexOf(node.id) >= 0) origins[node.id] = { x: node.x, y: node.y } })
        history.commit(function (previous) { return moveNodesBy(previous, origins, dx, dy) }, 'nudge')
      }

      function requestRemoveMember(memberId) {
        const member = membersById[memberId]
        if (!member) return
        const uses = draftRef.current.flow.nodes.filter(function (node) { return node.type === 'step' && node.memberId === memberId }).length
        if (uses > 0) {
          setDialog({ kind: 'removeMember', member: member, uses: uses })
          return
        }
        history.commit(function (previous) { return removeMemberFrom(previous, memberId) })
        select(EMPTY_SELECTION)
      }

      /* ----- saving / leaving ----- */

      async function save() {
        if (saving) return
        const payload = teamPayload(draftRef.current)
        if (!payload.name) {
          showToast('error', t('teamNameRequired'))
          return
        }
        if (incompleteEntry(draftRef.current)) {
          showToast('error', t('entryInvalid'))
          select(EMPTY_SELECTION)
          return
        }
        // The lead must be an orchestrator bit (V5-CONTRACT.md §5.1).
        if (payload.lead) {
          const leadMember = payload.members.find(function (member) { return member.id === payload.lead })
          const leadBit = leadMember && leadMember.bitId ? bitsById[leadMember.bitId] : null
          if (!leadBit || leadBit.isOrchestrator !== true) {
            showToast('error', t('leadNotOrchestrator'))
            select(EMPTY_SELECTION)
            return
          }
        }
        setSaving(true)
        try {
          const saved = await teamsApi.update(props.team.id, draftRef.current)
          const next = draftOf(saved)
          setSavedJson(canonicalJson(next))
          history.replace(next)
          if (typeof props.onSaved === 'function') props.onSaved(saved)
          showToast('success', t('teamSaved'))
        } catch (error) {
          showToast('error', t('saveFailed') + ': ' + describeError(error))
        } finally {
          setSaving(false)
        }
      }

      function requestClose() {
        if (dirty) setDialog({ kind: 'discard' })
        else props.onClose()
      }

      /* ----- keyboard ----- */

      const keyHandlerRef = React.useRef(null)
      keyHandlerRef.current = function (event) {
        if (document.querySelector('.dsh-bots-overlay')) return
        const root = rootRef.current
        const active = document.activeElement
        if (root && active && active !== document.body && !root.contains(active)) return
        const mod = event.ctrlKey || event.metaKey
        const key = event.key
        if (mod && (key === 's' || key === 'S')) {
          event.preventDefault()
          save()
          return
        }
        if (isTypingTarget(event.target)) return
        if (mod && (key === 'z' || key === 'Z')) {
          event.preventDefault()
          if (event.shiftKey) history.redo()
          else history.undo()
          return
        }
        if (mod && (key === 'y' || key === 'Y')) {
          event.preventDefault()
          history.redo()
          return
        }
        if (mod && (key === 'd' || key === 'D')) {
          event.preventDefault()
          duplicateSelection()
          return
        }
        if (mod && (key === 'a' || key === 'A')) {
          event.preventDefault()
          select({ nodes: draftRef.current.flow.nodes.map(function (node) { return node.id }), edge: null, member: null })
          return
        }
        if (key === 'Delete' || key === 'Backspace') {
          event.preventDefault()
          deleteSelection()
          return
        }
        if (key === 'Escape') {
          if (interactionRef.current) {
            interactionRef.current = null
            setOverlay(null)
            setPanning(false)
          } else {
            select(EMPTY_SELECTION)
          }
          return
        }
        const step = event.shiftKey ? GRID * 5 : GRID
        if (key === 'ArrowLeft') { event.preventDefault(); nudge(-step, 0) }
        else if (key === 'ArrowRight') { event.preventDefault(); nudge(step, 0) }
        else if (key === 'ArrowUp') { event.preventDefault(); nudge(0, -step) }
        else if (key === 'ArrowDown') { event.preventDefault(); nudge(0, step) }
        else if (key === '+' || key === '=') zoomAt(1.2)
        else if (key === '-') zoomAt(1 / 1.2)
        else if (key === '0') fitView(false)
      }

      React.useEffect(function () {
        function onKeyDown(event) { if (keyHandlerRef.current) keyHandlerRef.current(event) }
        document.addEventListener('keydown', onKeyDown)
        return function () { document.removeEventListener('keydown', onKeyDown) }
      }, [])

      /* ----- pointer interactions on the board ----- */

      function nodeIdAt(clientX, clientY) {
        if (typeof document.elementFromPoint !== 'function') return null
        const element = document.elementFromPoint(clientX, clientY)
        const nodeElement = element && element.closest ? element.closest('[data-flow-node]') : null
        return nodeElement ? nodeElement.getAttribute('data-flow-node') : null
      }

      function onPointerDown(event) {
        if (event.button !== 0 && event.button !== 1) return
        const target = event.target
        if (!target || !target.closest) return
        const point = toCanvas(event.clientX, event.clientY)
        const canvas = canvasRef.current
        if (canvas && document.activeElement !== canvas && !isTypingTarget(document.activeElement)) {
          try { canvas.focus({ preventScroll: true }) } catch (error) { /* best effort */ }
        } else if (canvas && isTypingTarget(document.activeElement)) {
          try { document.activeElement.blur(); canvas.focus({ preventScroll: true }) } catch (error) { /* best effort */ }
        }

        if (event.button === 1) {
          event.preventDefault()
          interactionRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, origin: viewRef.current, moved: true }
          setPanning(true)
          return
        }

        const handle = target.closest('[data-flow-handle]')
        const resize = target.closest('[data-flow-resize]')
        const nodeElement = target.closest('[data-flow-node]')
        const edgeElement = target.closest('[data-flow-edge]')

        if (handle && nodeElement) {
          event.preventDefault()
          const fromId = nodeElement.getAttribute('data-flow-node')
          const from = nodesById[fromId]
          if (!from) return
          const start = handlePoint(nodeRect(from), handle.getAttribute('data-flow-handle'))
          interactionRef.current = { kind: 'connect', from: fromId, start: start }
          setOverlay({ kind: 'connect', from: fromId, x1: start.x, y1: start.y, x2: point.x, y2: point.y, target: null })
          return
        }

        if (resize) {
          event.preventDefault()
          const id = resize.getAttribute('data-flow-resize')
          const node = nodesById[id]
          if (!node) return
          const size = nodeSize(node)
          interactionRef.current = { kind: 'resize', id: id, start: point, w: size[0], h: size[1], moved: false }
          select({ nodes: [id], edge: null, member: null })
          return
        }

        if (nodeElement) {
          const id = nodeElement.getAttribute('data-flow-node')
          const current = selectionRef.current
          const toggle = event.shiftKey || event.metaKey || event.ctrlKey
          let ids
          let collapseOnClick = false
          if (toggle) {
            const has = current.nodes.indexOf(id) >= 0
            ids = has ? current.nodes.filter(function (other) { return other !== id }) : current.nodes.concat([id])
            select({ nodes: ids, edge: null, member: null })
            if (has) return
          } else if (current.nodes.indexOf(id) >= 0) {
            ids = current.nodes
            collapseOnClick = current.nodes.length > 1
            if (current.edge || current.member) select({ nodes: ids, edge: null, member: null })
          } else {
            ids = [id]
            select({ nodes: ids, edge: null, member: null })
          }
          const nodes = draftRef.current.flow.nodes
          const moving = {}
          ids.forEach(function (other) { moving[other] = true })
          if (!event.altKey) {
            nodes.forEach(function (node) {
              if (node.type !== 'group' || !moving[node.id]) return
              const frame = nodeRect(node)
              nodes.forEach(function (other) {
                if (other.id !== node.id && rectContains(frame, nodeRect(other))) moving[other.id] = true
              })
            })
          }
          const origins = {}
          nodes.forEach(function (node) { if (moving[node.id]) origins[node.id] = { x: node.x, y: node.y } })
          interactionRef.current = { kind: 'move', id: id, start: point, origins: origins, moved: false, collapseOnClick: collapseOnClick }
          return
        }

        if (edgeElement) {
          select({ nodes: [], edge: edgeElement.getAttribute('data-flow-edge'), member: null })
          return
        }

        if (event.shiftKey) {
          interactionRef.current = { kind: 'marquee', start: point, additive: selectionRef.current.nodes.slice() }
          setOverlay({ kind: 'marquee', x: point.x, y: point.y, w: 0, h: 0 })
          return
        }
        interactionRef.current = { kind: 'pan', startX: event.clientX, startY: event.clientY, origin: viewRef.current, moved: false }
        setPanning(true)
      }

      const pointerHandlersRef = React.useRef(null)
      pointerHandlersRef.current = {
        move: function (event) {
          const interaction = interactionRef.current
          if (!interaction) return
          if (interaction.kind === 'pan') {
            const dx = event.clientX - interaction.startX
            const dy = event.clientY - interaction.startY
            if (!interaction.moved && Math.abs(dx) + Math.abs(dy) < 3) return
            interaction.moved = true
            setView({ k: interaction.origin.k, x: interaction.origin.x + dx, y: interaction.origin.y + dy })
            return
          }
          const point = toCanvas(event.clientX, event.clientY)
          if (interaction.kind === 'move') {
            const dx = point.x - interaction.start.x
            const dy = point.y - interaction.start.y
            if (!interaction.moved) {
              if (Math.abs(dx) * viewRef.current.k + Math.abs(dy) * viewRef.current.k < 4) return
              interaction.moved = true
              history.checkpoint()
            }
            history.transient(function (previous) { return moveNodesBy(previous, interaction.origins, dx, dy) })
            return
          }
          if (interaction.kind === 'resize') {
            if (!interaction.moved) {
              interaction.moved = true
              history.checkpoint()
            }
            const w = clamp(snap(interaction.w + point.x - interaction.start.x), 96, 4000)
            const hgt = clamp(snap(interaction.h + point.y - interaction.start.y), 56, 4000)
            history.transient(function (previous) { return patchNode(previous, interaction.id, { w: w, h: hgt }) })
            return
          }
          if (interaction.kind === 'connect') {
            const targetId = nodeIdAt(event.clientX, event.clientY)
            setOverlay({
              kind: 'connect', from: interaction.from,
              x1: interaction.start.x, y1: interaction.start.y, x2: point.x, y2: point.y,
              target: targetId && targetId !== interaction.from ? targetId : null,
            })
            return
          }
          if (interaction.kind === 'marquee') {
            const x = Math.min(point.x, interaction.start.x)
            const y = Math.min(point.y, interaction.start.y)
            setOverlay({ kind: 'marquee', x: x, y: y, w: Math.abs(point.x - interaction.start.x), h: Math.abs(point.y - interaction.start.y) })
          }
        },
        up: function (event) {
          const interaction = interactionRef.current
          interactionRef.current = null
          if (!interaction) return
          if (interaction.kind === 'pan') {
            setPanning(false)
            if (!interaction.moved) select(EMPTY_SELECTION)
            return
          }
          if (interaction.kind === 'move') {
            if (!interaction.moved && interaction.collapseOnClick) select({ nodes: [interaction.id], edge: null, member: null })
            return
          }
          if (interaction.kind === 'connect') {
            setOverlay(null)
            const targetId = nodeIdAt(event.clientX, event.clientY)
            if (!targetId || targetId === interaction.from) return
            let createdId = null
            history.commit(function (previous) {
              const result = addEdgeTo(previous, interaction.from, targetId, 'flow')
              createdId = result.id
              return result.draft
            })
            setTimeout(function () { if (createdId) select({ nodes: [], edge: createdId, member: null }) }, 0)
            return
          }
          if (interaction.kind === 'marquee') {
            setOverlay(null)
            const point = toCanvas(event.clientX, event.clientY)
            const box = {
              x: Math.min(point.x, interaction.start.x), y: Math.min(point.y, interaction.start.y),
              w: Math.abs(point.x - interaction.start.x), h: Math.abs(point.y - interaction.start.y),
            }
            const picked = interaction.additive.slice()
            draftRef.current.flow.nodes.forEach(function (node) {
              const rect = nodeRect(node)
              const hit = node.type === 'group' ? rectContains(box, rect) : rectsIntersect(box, rect)
              if (hit && picked.indexOf(node.id) < 0) picked.push(node.id)
            })
            select({ nodes: picked, edge: null, member: null })
          }
        },
      }

      React.useEffect(function () {
        function onMove(event) { if (pointerHandlersRef.current) pointerHandlersRef.current.move(event) }
        function onUp(event) { if (pointerHandlersRef.current) pointerHandlersRef.current.up(event) }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
        return function () {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
      }, [])

      function onDoubleClick(event) {
        const target = event.target
        if (!target || !target.closest) return
        const nodeElement = target.closest('[data-flow-node]')
        if (nodeElement) {
          const id = nodeElement.getAttribute('data-flow-node')
          select({ nodes: [id], edge: null, member: null }, id)
          return
        }
        const edgeElement = target.closest('[data-flow-edge]')
        if (edgeElement) return
        createNode('step', null, toCanvas(event.clientX, event.clientY))
      }

      /* ----- drag and drop from the side palette ----- */

      function onDragStartItem(event, payload) {
        try {
          event.dataTransfer.setData(DND_TYPE, JSON.stringify(payload))
          event.dataTransfer.setData('text/plain', payload.type)
          event.dataTransfer.effectAllowed = 'copy'
        } catch (error) { /* drag data is best effort */ }
      }

      function onDragOver(event) {
        const types = event.dataTransfer && event.dataTransfer.types ? Array.prototype.slice.call(event.dataTransfer.types) : []
        if (types.indexOf(DND_TYPE) < 0) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }

      function onDrop(event) {
        let payload = null
        try { payload = JSON.parse(event.dataTransfer.getData(DND_TYPE)) } catch (error) { payload = null }
        if (!isObject(payload) || NODE_TYPES.indexOf(payload.type) < 0) return
        event.preventDefault()
        createNode(payload.type, asString(payload.memberId) || null, toCanvas(event.clientX, event.clientY))
      }

      /* ----- members ----- */

      function addMemberFromBit(bit) {
        const member = memberFromBit(bit, draftRef.current.members, catalog, lang)
        history.commit(function (previous) { return Object.assign({}, previous, { members: previous.members.concat([member]) }) })
        setDialog(null)
        select({ nodes: [], edge: null, member: member.id })
      }

      /** Re-point one member at another bit; role stays (only filled when empty). */
      function changeMemberBit(memberId, bitId) {
        const member = membersById[memberId]
        const bit = bitId ? bitsById[bitId] || null : null
        if (!member || !bit) return
        const character = bitCharacter(bit, catalog)
        const patch = { bitId: bit.id }
        if (!member.role) patch.role = character ? summaryOf(character, lang).slice(0, 200) : excerpt(bit.instructions, 200)
        history.commit(function (previous) { return patchMember(previous, memberId, patch) })
      }

      /* ----- render: board ----- */

      const selectedNodes = {}
      liveSelection.nodes.forEach(function (id) { selectedNodes[id] = true })
      const highlightMember = liveSelection.member
      const rects = {}
      draft.flow.nodes.forEach(function (node) { rects[node.id] = nodeRect(node) })
      const pairs = {}
      draft.flow.edges.forEach(function (edge) { pairs[edge.from + '>' + edge.to] = true })

      const bounds = flowBounds(draft.flow.nodes) || { x: 0, y: 0, w: 1, h: 1 }
      const margin = 2400
      const svgBox = { x: bounds.x - margin, y: bounds.y - margin, w: bounds.w + margin * 2, h: bounds.h + margin * 2 }

      const edgePaths = []
      const edgeLabels = []
      draft.flow.edges.forEach(function (edge) {
        const a = rects[edge.from]
        const b = rects[edge.to]
        if (!a || !b) return
        const twin = !!pairs[edge.to + '>' + edge.from]
        const shift = twin ? (edge.from < edge.to ? 9 : -9) : 0
        const geometry = edgeGeometry(a, b, shift)
        const selected = liveSelection.edge === edge.id
        const related = !selected && (selectedNodes[edge.from] || selectedNodes[edge.to])
        const kindClass = edge.kind !== 'flow' && EDGE_KINDS.indexOf(edge.kind) >= 0 ? ' dsh-flow-edge-' + edge.kind : ''
        const marker = selected ? 'selected' : edge.kind
        edgePaths.push(h('g', { key: edge.id },
          h('path', { className: 'dsh-flow-edge-hit', d: geometry.d, 'data-flow-edge': edge.id }),
          h('path', {
            className: 'dsh-flow-edge' + kindClass + (selected ? ' is-selected' : '') + (related ? ' is-related' : ''),
            d: geometry.d,
            markerEnd: 'url(#dsh-flow-arrow-' + marker + ')',
          })))
        if (edge.label) {
          edgeLabels.push(h('div', {
            key: 'label-' + edge.id,
            className: 'dsh-flow-edge-label' + (edge.kind !== 'flow' ? ' dsh-flow-edge-label-' + edge.kind : '') + (selected ? ' is-selected' : ''),
            'data-flow-edge': edge.id,
            title: edge.label,
            style: { left: geometry.mx, top: geometry.my },
          }, edge.label))
        }
      })

      function arrowMarker(id, className) {
        return h('marker', {
          key: id, id: 'dsh-flow-arrow-' + id, viewBox: '0 0 10 10', refX: 9, refY: 5,
          markerWidth: 7, markerHeight: 7, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse',
        }, h('path', { d: 'M0,0 L10,5 L0,10 z', className: className }))
      }

      let tempEdge = null
      if (overlay && overlay.kind === 'connect') {
        const end = overlay.target && rects[overlay.target]
          ? { x: rects[overlay.target].x + rects[overlay.target].w / 2, y: rects[overlay.target].y + rects[overlay.target].h / 2 }
          : { x: overlay.x2, y: overlay.y2 }
        tempEdge = h('path', { className: 'dsh-flow-edge-temp', d: 'M' + overlay.x1 + ',' + overlay.y1 + ' L' + end.x + ',' + end.y, markerEnd: 'url(#dsh-flow-arrow-selected)' })
      }

      const handles = ['top', 'right', 'bottom', 'left'].map(function (side) {
        return h('span', { key: side, className: 'dsh-flow-handle dsh-flow-handle-' + side, 'data-flow-handle': side, title: t('shortcutConnect'), 'aria-hidden': 'true' })
      })

      function nodeStyle(node, color) {
        const rect = rects[node.id]
        return {
          left: rect.x, top: rect.y, width: rect.w, height: rect.h,
          '--node-color': color, '--node-tint': hexAlpha(color, node.type === 'note' ? 0.14 : 0.09), '--node-border': hexAlpha(color, 0.55),
        }
      }

      const groupNodes = []
      const plainNodes = []
      draft.flow.nodes.forEach(function (node) {
        const color = nodeColor(node, membersById, catalog, bitsById)
        const selected = !!selectedNodes[node.id]
        const dimmed = !!highlightMember && !(node.type === 'step' && node.memberId === highlightMember)
        const target = overlay && overlay.kind === 'connect' && overlay.target === node.id
        const labelText = node.label || t('untitled')
        if (node.type === 'group') {
          groupNodes.push(h('div', {
            key: node.id,
            className: 'dsh-flow-group' + (selected ? ' is-selected' : '') + (dimmed ? ' is-dimmed' : ''),
            style: nodeStyle(node, color),
          },
            h('div', { className: 'dsh-flow-group-head', 'data-flow-node': node.id, title: node.detail || labelText },
              h('span', { 'aria-hidden': 'true' }, h(FrameIcon, { size: 14 })),
              h('span', { className: 'dsh-flow-group-title' }, labelText)),
            h('span', { className: 'dsh-flow-resize', 'data-flow-resize': node.id, title: t('resize') || '', 'aria-hidden': 'true' })))
          return
        }
        const className = 'dsh-flow-node dsh-flow-node-' + node.type + (selected ? ' is-selected' : '') + (dimmed ? ' is-dimmed' : '') + (target ? ' is-target' : '')
        let content
        if (node.type === 'step') {
          const member = node.memberId ? membersById[node.memberId] : null
          const memberBitRecord = member ? memberBit(member, bitsById) : null
          const meta = member
            ? [memberName(member, bitsById), memberRouteText(member, bitsById, models)].filter(Boolean).join(' · ')
            : t('noMember')
          content = [
            member
              ? h(BitAvatar, { key: 'avatar', bit: avatarBitOf(memberBitRecord, catalog), size: 42, emoji: '🤖', color: color })
              : h('span', { key: 'avatar', className: 'dsh-flow-avatar-empty', 'aria-hidden': 'true' }, '?'),
            h('span', { key: 'text', className: 'dsh-flow-text' },
              h('span', { className: 'dsh-flow-label' + (node.label ? '' : ' dsh-flow-label-empty') }, labelText),
              h('span', { className: 'dsh-flow-meta' }, meta)),
          ]
        } else if (node.type === 'team') {
          const ref = node.teamRef ? teamsById[node.teamRef] || null : null
          content = [
            h('span', { key: 'avatar', className: 'dsh-flow-team-emoji', 'aria-hidden': 'true' },
              ref ? (ref.emoji || '👥') : h(TeamGlyph, { size: 18 })),
            h('span', { key: 'text', className: 'dsh-flow-text' },
              h('span', { className: 'dsh-flow-kicker' }, t('nodeTeam')),
              h('span', { className: 'dsh-flow-label' + (node.label ? '' : ' dsh-flow-label-empty'), style: { WebkitLineClamp: 1 } }, labelText),
              h('span', { className: 'dsh-flow-meta' + (ref ? '' : ' dsh-flow-meta-empty') },
                ref ? (ref.emoji || '👥') + ' ' + ref.name : (node.teamRef ? t('teamNodeMissing') : t('teamNodeNone')))),
          ]
        } else if (node.type === 'note') {
          content = [
            h('span', { key: 'title', className: 'dsh-flow-note-title' }, labelText),
            node.detail ? h('span', { key: 'text', className: 'dsh-flow-note-text' }, node.detail) : null,
            h('span', { key: 'resize', className: 'dsh-flow-resize', 'data-flow-resize': node.id, 'aria-hidden': 'true' }),
          ]
        } else {
          content = [
            h('span', { key: 'icon', className: 'dsh-flow-icon', 'aria-hidden': 'true' }, typeIcon(node.type, node.type === 'start' || node.type === 'end' ? 12 : 15)),
            h('span', { key: 'text', className: 'dsh-flow-text' },
              node.type === 'decision' || node.type === 'pause' ? h('span', { className: 'dsh-flow-kicker' }, t(TYPE_LABEL_KEY[node.type])) : null,
              h('span', { className: 'dsh-flow-label' + (node.label ? '' : ' dsh-flow-label-empty') }, labelText)),
          ]
        }
        plainNodes.push(h('div', {
          key: node.id,
          className: className,
          'data-flow-node': node.id,
          style: nodeStyle(node, color),
          title: node.type === 'note' ? undefined : (node.detail ? labelText + '\n\n' + node.detail : labelText),
          tabIndex: 0,
          role: 'button',
          'aria-pressed': selected ? 'true' : 'false',
          'aria-label': t(TYPE_LABEL_KEY[node.type]) + ': ' + labelText,
          onKeyDown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              select({ nodes: [node.id], edge: null, member: null }, event.key === 'Enter' ? node.id : null)
            }
          },
        }, content, handles))
      })

      const marquee = overlay && overlay.kind === 'marquee'
        ? h('div', { className: 'dsh-flow-marquee', style: { left: overlay.x, top: overlay.y, width: overlay.w, height: overlay.h } })
        : null

      const board = h('div', {
        ref: canvasRef,
        className: 'dsh-flow-canvas' + (panning ? ' is-panning' : '') + (overlay && overlay.kind === 'connect' ? ' is-connecting' : ''),
        tabIndex: 0,
        role: 'application',
        'aria-label': t('canvasLabel'),
        onPointerDown: onPointerDown,
        onDoubleClick: onDoubleClick,
        onDragOver: onDragOver,
        onDrop: onDrop,
        onContextMenu: function (event) { event.preventDefault() },
        onScroll: function (event) {
          const element = event.currentTarget
          if (element.scrollLeft !== 0 || element.scrollTop !== 0) {
            element.scrollLeft = 0
            element.scrollTop = 0
          }
        },
        style: {
          backgroundSize: (24 * view.k) + 'px ' + (24 * view.k) + 'px',
          backgroundPosition: view.x + 'px ' + view.y + 'px',
        },
      },
        h('div', { className: 'dsh-flow-layer', style: { transform: 'translate(' + view.x + 'px, ' + view.y + 'px) scale(' + view.k + ')' } },
          groupNodes,
          h('svg', {
            className: 'dsh-flow-edges',
            style: { left: svgBox.x, top: svgBox.y, width: svgBox.w, height: svgBox.h },
            width: svgBox.w,
            height: svgBox.h,
            viewBox: svgBox.x + ' ' + svgBox.y + ' ' + svgBox.w + ' ' + svgBox.h,
          },
            h('defs', null,
              arrowMarker('flow', 'dsh-flow-arrow'),
              arrowMarker('loop', 'dsh-flow-arrow dsh-flow-arrow-loop'),
              arrowMarker('delegate', 'dsh-flow-arrow dsh-flow-arrow-delegate'),
              arrowMarker('handoff', 'dsh-flow-arrow dsh-flow-arrow-handoff'),
              arrowMarker('selected', 'dsh-flow-arrow dsh-flow-arrow-selected')),
            edgePaths,
            tempEdge),
          edgeLabels,
          plainNodes,
          marquee),
        draft.flow.nodes.length === 0 ? h('div', { className: 'dsh-flow-empty' }, t('emptyCanvas')) : null,
        h('div', { className: 'dsh-flow-legend', 'aria-hidden': 'true' },
          legendItem('flow', t('legendFlow')),
          legendItem('loop', t('legendLoop')),
          legendItem('delegate', t('legendDelegate')),
          legendItem('handoff', t('legendHandoff')))
      )

      function legendItem(kind, label) {
        const stroke = kind === 'loop' ? 'var(--dsh-bots-warn)' : (kind === 'delegate' ? 'var(--dsh-bots-accent)' : (kind === 'handoff' ? HANDOFF_COLOR : 'var(--dsh-bots-text-3)'))
        const dash = { loop: '5 3', delegate: '1.5 4', handoff: '7 3' }
        return h('span', { key: kind },
          h('svg', { width: 26, height: 8, 'aria-hidden': 'true' },
            h('line', {
              x1: 1, y1: 4, x2: 25, y2: 4, stroke: stroke, strokeWidth: kind === 'delegate' ? 2 : (kind === 'handoff' ? 1.8 : 1.6),
              strokeDasharray: dash[kind], strokeLinecap: kind === 'handoff' ? 'butt' : 'round',
            })),
          label)
      }

      /* ----- render: side palette and members ----- */

      const paletteTypes = ['start', 'step', 'team', 'decision', 'pause', 'end', 'group', 'note']
      const stepCounts = {}
      draft.flow.nodes.forEach(function (node) {
        if (node.type === 'step' && node.memberId) stepCounts[node.memberId] = (stepCounts[node.memberId] || 0) + 1
      })

      const side = h('aside', { className: 'dsh-team-side', 'aria-label': t('palette') },
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' }, t('palette')),
          h('div', { className: 'dsh-team-palette' }, paletteTypes.map(function (type) {
            const color = TYPE_COLOR[type]
            return h('button', {
              key: type,
              type: 'button',
              className: 'dsh-team-palette-item',
              draggable: true,
              title: t('paletteHint'),
              onDragStart: function (event) { onDragStartItem(event, { type: type }) },
              onClick: function () { createAtCenter(type, null) },
            },
              h('span', { className: 'dsh-team-type-icon', style: { '--node-color': color, '--node-tint': hexAlpha(color, 0.14) }, 'aria-hidden': 'true' }, typeIcon(type, 12)),
              h('span', null, t(TYPE_LABEL_KEY[type])))
          })),
          h('p', { className: 'dsh-bots-hint' }, t('paletteHint'))),
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' },
            h('span', null, t('members') + ' (' + draft.members.length + ')'),
            h(Button, { variant: 'ghost', size: 'sm', onClick: function () { setDialog({ kind: 'addMember' }) } }, h(PlusIcon, { size: 12 }), t('addMember'))),
          draft.members.length === 0
            ? h('p', { className: 'dsh-bots-hint' }, t('membersEmpty'))
            : h('ul', { className: 'dsh-team-members' }, draft.members.map(function (member) {
              const memberBitRecord = memberBit(member, bitsById)
              const ref = member.teamRef ? teamsById[member.teamRef] || null : null
              const meta = member.teamRef
                ? '→ ' + (ref ? ref.name : t('teamNodeMissing'))
                : ([memberRouteText(member, bitsById, models), member.access === 'read' ? t('accessRead') : null].filter(Boolean).join(' · ') || member.role)
              const isLead = draft.lead === member.id
              return h('li', { key: member.id, 'data-member-id': member.id },
                h('button', {
                  type: 'button',
                  className: 'dsh-team-member',
                  draggable: true,
                  'aria-pressed': liveSelection.member === member.id ? 'true' : 'false',
                  title: t('memberDragHint'),
                  onDragStart: function (event) { onDragStartItem(event, { type: 'step', memberId: member.id }) },
                  onClick: function () {
                    select(liveSelection.member === member.id ? EMPTY_SELECTION : { nodes: [], edge: null, member: member.id })
                  },
                },
                  h(BitAvatar, { bit: avatarBitOf(memberBitRecord, catalog), size: 30, emoji: '🤖', color: TYPE_COLOR.end }),
                  h('span', { className: 'dsh-team-member-text' },
                    h('span', { className: 'dsh-team-member-row' },
                      h('span', { className: 'dsh-team-member-name' }, memberName(member, bitsById)),
                      isLead ? h('span', { className: 'dsh-team-tag' }, t('leadBadge')) : null),
                    meta ? h('span', { className: 'dsh-team-member-meta' + (member.teamRef ? ' dsh-team-member-ref' : '') }, meta) : null),
                  h('span', { className: 'dsh-team-count', title: tf(t, 'memberSteps', { n: stepCounts[member.id] || 0 }) }, String(stepCounts[member.id] || 0))))
            })),
          draft.members.length > 0 ? h('p', { className: 'dsh-bots-hint' }, t('memberDragHint')) : null)
      )

      /* ----- render: inspector ----- */

      let inspector
      if (liveSelection.member) {
        inspector = h(MemberInspector, {
          key: 'member-' + liveSelection.member,
          t: t, lang: lang, catalog: catalog,
          member: membersById[liveSelection.member],
          members: draft.members,
          uses: stepCounts[liveSelection.member] || 0,
          isLead: draft.lead === liveSelection.member,
          otherTeams: otherTeams,
          teamsById: teamsById,
          harnessId: draft.harness,
          pack: pack,
          packs: packs,
          bits: bitsState,
          bitsById: bitsById,
          models: models,
          commit: history.commit,
          onChangeBit: changeMemberBit,
          onRemove: function () { requestRemoveMember(liveSelection.member) },
        })
      } else if (liveSelection.edge) {
        const edge = draft.flow.edges.find(function (item) { return item.id === liveSelection.edge })
        inspector = h(EdgeInspector, {
          key: 'edge-' + edge.id,
          t: t, edge: edge, nodesById: nodesById,
          commit: history.commit,
          onSelectNode: function (id) { select({ nodes: [id], edge: null, member: null }) },
          onDelete: deleteSelection,
        })
      } else if (liveSelection.nodes.length === 1) {
        const node = nodesById[liveSelection.nodes[0]]
        inspector = h(NodeInspector, {
          key: 'node-' + node.id,
          t: t, node: node, draft: draft, nodesById: nodesById, membersById: membersById, catalog: catalog,
          bitsById: bitsById, models: models,
          otherTeams: otherTeams, teamsById: teamsById,
          focusToken: focusRequest && focusRequest.nodeId === node.id ? focusRequest.seq : 0,
          commit: history.commit,
          onSelectEdge: function (id) { select({ nodes: [], edge: id, member: null }) },
          onDuplicate: duplicateSelection,
          onDelete: deleteSelection,
        })
      } else if (liveSelection.nodes.length > 1) {
        inspector = h('div', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' }, t('nodeProps')),
          h('p', { className: 'dsh-bots-hint' }, tf(t, 'selectedCount', { n: liveSelection.nodes.length })),
          h('div', { className: 'dsh-team-inline' },
            h(Button, { variant: 'outline', size: 'sm', onClick: duplicateSelection }, h(CopyIcon, { size: 13 }), t('duplicate')),
            h(Button, { variant: 'ghost', size: 'sm', className: 'dsh-bots-button-danger', onClick: deleteSelection }, h(TrashIcon, { size: 13 }), t('remove'))))
      } else {
        inspector = h(TeamInspector, {
          t: t, draft: draft, commit: history.commit,
          teamId: props.team.id, teams: allTeams,
          projects: Array.isArray(props.projects) ? props.projects : [],
          packs: packs, pack: pack, onReloadPacks: props.onReloadPacks,
          bits: bitsState, bitsById: bitsById, models: models,
        })
      }

      /* ----- render: frame ----- */

      const zoomPercent = Math.round(view.k * 100) + '%'
      const bar = h('div', { className: 'dsh-team-bar' },
        h(IconButton, { label: backLabel, onClick: requestClose }, h(ArrowLeftIcon, { size: 16 })),
        h('div', { className: 'dsh-team-bar-title' },
          h('span', { 'aria-hidden': 'true', style: { fontSize: 18 } }, draft.emoji || '👥'),
          h('span', { className: 'dsh-team-bar-name', title: draft.name }, draft.name || t('untitled')),
          h(Badge, { label: dirty ? t('unsaved') : t('allSaved'), tone: dirty ? 'warn' : 'ok' })),
        h(IconButton, { label: t('togglePalette'), onClick: function () { setPanels({ side: !panels.side, inspector: panels.inspector }) } }, h(PanelLeftIcon, { size: 16 })),
        h(IconButton, { label: t('toggleInspector'), onClick: function () { setPanels({ side: panels.side, inspector: !panels.inspector }) } }, h(PanelRightIcon, { size: 16 })),
        h('span', { className: 'dsh-team-bar-sep', 'aria-hidden': 'true' }),
        h(IconButton, { label: t('undo'), disabled: !history.canUndo, onClick: history.undo }, h(UndoIcon, { size: 16 })),
        h(IconButton, { label: t('redo'), disabled: !history.canRedo, onClick: history.redo }, h(RedoIcon, { size: 16 })),
        h('span', { className: 'dsh-team-bar-sep', 'aria-hidden': 'true' }),
        h(IconButton, { label: t('zoomOut'), onClick: function () { zoomAt(1 / 1.2) } }, h(MinusIcon, { size: 16 })),
        h('span', { className: 'dsh-team-zoom', 'aria-live': 'polite' }, zoomPercent),
        h(IconButton, { label: t('zoomIn'), onClick: function () { zoomAt(1.2) } }, h(PlusIcon, { size: 16 })),
        h(IconButton, { label: t('zoomFit'), onClick: function () { fitView(false) } }, h(FitIcon, { size: 16 })),
        h('span', { className: 'dsh-team-bar-sep', 'aria-hidden': 'true' }),
        h(Button, { variant: 'primary', disabled: saving || !dirty, busy: saving, title: t('saveShortcut'), onClick: save },
          h(SaveIcon, { size: 14 }), saving ? t('saving') : t('save'))
      )

      let dialogNode = null
      if (dialog && dialog.kind === 'discard') {
        dialogNode = h(ConfirmDialog, {
          key: 'discard', t: t, destructive: true,
          title: t('discardTitle'), description: t('discardBody'), confirmLabel: t('discard'),
          onCancel: function () { setDialog(null) },
          onConfirm: function () { setDialog(null); props.onClose() },
        })
      } else if (dialog && dialog.kind === 'addMember') {
        const memberNames = {}
        draft.members.forEach(function (member) { memberNames[member.bitId] = true })
        const available = bitsState.list.filter(function (bit) { return !memberNames[bit.id] })
        dialogNode = h(AddMemberDialog, {
          key: 'addMember',
          t: t,
          lang: lang,
          catalog: catalog,
          bits: available,
          phase: bitsState.phase,
          onCancel: function () { setDialog(null) },
          onPick: addMemberFromBit,
        })
      } else if (dialog && dialog.kind === 'removeMember') {
        dialogNode = h(ConfirmDialog, {
          key: 'removeMember', t: t, destructive: true,
          title: tf(t, 'removeMemberTitle', { name: memberName(dialog.member, bitsById) }),
          description: tf(t, 'removeMemberBody', { n: dialog.uses }),
          confirmLabel: t('removeMember'),
          onCancel: function () { setDialog(null) },
          onConfirm: function () {
            const id = dialog.member.id
            history.commit(function (previous) { return removeMemberFrom(previous, id) })
            setDialog(null)
            select(EMPTY_SELECTION)
          },
        })
      }

      return h('div', { className: 'dsh-team-editor', ref: rootRef },
        bar,
        h('div', { className: 'dsh-team-body' },
          panels.side ? side : null,
          board,
          panels.inspector ? h('aside', { className: 'dsh-team-inspector', ref: inspectorRef, 'aria-label': t('teamProps') }, inspector) : null),
        dialogNode)
    }

    /* ------------------------- inspectors ------------------------- */

    function TeamInspector(props) {
      const t = props.t
      const draft = props.draft
      const stats = teamStats(draft)
      const workspace = asString(draft.workspaceDir)
      const workspaceBad = workspace.trim() !== '' && !/^(\/|[A-Za-z]:[\\/]|~\/)/.test(workspace.trim())
      const projects = Array.isArray(props.projects) ? props.projects : []
      const projectIds = Array.isArray(draft.projectIds) ? draft.projectIds : []
      const [sharedHint, setSharedHint] = React.useState(false)
      // Referenced projects missing from the list stay visible so they can be cleared (§12.4).
      const projectItems = projects.slice()
      projectIds.forEach(function (id) {
        if (!findProject(projects, id)) projectItems.push({ id: id, name: t('projectUnknown') + ' (' + id + ')', emoji: '' })
      })
      function set(field, value) {
        props.commit(function (previous) {
          const patch = {}
          patch[field] = value
          return Object.assign({}, previous, patch)
        }, 'team:' + field)
      }
      function changeShared(checked) {
        const hadMany = projectIds.length > 1
        props.commit(function (previous) {
          const ids = Array.isArray(previous.projectIds) ? previous.projectIds : []
          const next = Object.assign({}, previous, { shared: checked === true })
          if (!checked && ids.length > 1) next.projectIds = [ids[0]]
          return next
        }, 'team:shared')
        setSharedHint(!checked && hadMany)
      }
      function toggleProject(id, checked) {
        const next = projectIds.filter(function (other) { return other !== id })
        if (checked) next.push(id)
        setSharedHint(false)
        set('projectIds', next)
      }
      function pickProject(id) {
        setSharedHint(false)
        set('projectIds', id ? [id] : [])
      }
      return h(React.Fragment, null,
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' }, t('teamProps')),
          h(Field, { label: t('teamName'), htmlFor: 'dsh-team-prop-name', error: draft.name.trim() ? null : t('teamNameRequired') },
            h('input', { id: 'dsh-team-prop-name', className: 'dsh-bots-input', value: draft.name, maxLength: MAX_NAME, onChange: function (event) { set('name', event.target.value) } })),
          h('div', { className: 'dsh-bots-row' },
            h(Field, { label: 'Emoji', htmlFor: 'dsh-team-prop-emoji' },
              h('input', { id: 'dsh-team-prop-emoji', className: 'dsh-bots-input', style: { width: 64, textAlign: 'center' }, value: draft.emoji, maxLength: 8, onChange: function (event) { set('emoji', event.target.value) } })),
            h(Field, { label: t('color'), htmlFor: 'dsh-team-prop-color', grow: true },
              h('div', { className: 'dsh-bots-palette', id: 'dsh-team-prop-color' }, GROUP_COLORS.map(function (color) {
                return h('button', {
                  key: color, type: 'button', className: 'dsh-bots-swatch', style: { backgroundColor: color },
                  'aria-pressed': draft.color === color ? 'true' : 'false', 'aria-label': color,
                  onClick: function () { set('color', color) },
                })
              })))),
          h(Field, { label: t('teamDescription'), htmlFor: 'dsh-team-prop-description' },
            h('textarea', { id: 'dsh-team-prop-description', className: 'dsh-bots-textarea dsh-team-textarea-sm', value: draft.description, maxLength: 2000, placeholder: t('teamDescriptionPlaceholder'), onChange: function (event) { set('description', event.target.value) } })),
          h(Field, { label: t('teamWorkspace'), htmlFor: 'dsh-team-prop-workspace', hint: t('teamWorkspaceHint'), error: workspaceBad ? t('workspaceInvalid') : null },
            h('input', { id: 'dsh-team-prop-workspace', className: 'dsh-bots-input', style: { fontFamily: 'var(--dsh-bots-mono)' }, value: workspace, maxLength: 1024, placeholder: '/home/…/projeto', spellCheck: false, onChange: function (event) { set('workspaceDir', event.target.value) } })),
          h('p', { className: 'dsh-team-kv' }, tf(t, 'teamStats', stats))),
        // v4: shared flag + project assignment live in the team properties (§12.4).
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' }, t('tabProjects')),
          h('div', { className: 'dsh-bots-field', id: 'dsh-team-prop-shared' },
            h(Checkbox, {
              checked: draft.shared === true,
              label: t('sharedTeam'),
              onChange: changeShared,
            }),
            h('p', { className: 'dsh-bots-hint' }, t('sharedTeamHint')),
            sharedHint ? h('p', { className: 'dsh-bots-hint', role: 'status' }, t('sharedSingleProjectHint')) : null),
          draft.shared === true
            ? h(Field, { label: t('teamProjects'), htmlFor: 'dsh-team-prop-projects', hint: t('teamProjectsHint') },
              projectItems.length === 0
                ? h('p', { className: 'dsh-bots-hint' }, t('projectsEmpty'))
                : h('div', { className: 'dsh-team-launches', id: 'dsh-team-prop-projects' }, projectItems.map(function (project) {
                  return h(Checkbox, {
                    key: project.id,
                    checked: projectIds.indexOf(project.id) >= 0,
                    label: project.emoji ? project.emoji + ' ' + project.name : project.name,
                    onChange: function (checked) { toggleProject(project.id, checked) },
                  })
                })))
            : h(Field, { label: t('teamProjects'), htmlFor: 'dsh-team-prop-project', hint: t('teamProjectsHint') },
              h('select', {
                id: 'dsh-team-prop-project', className: 'dsh-bots-select', value: projectIds[0] || '',
                onChange: function (event) { pickProject(event.target.value) },
              },
                h('option', { value: '' }, t('noProject')),
                projects.map(function (project) {
                  return h('option', { key: project.id, value: project.id }, (project.emoji ? project.emoji + ' ' : '') + project.name)
                }),
                projectIds.length > 0 && !findProject(projects, projectIds[0])
                  ? h('option', { value: projectIds[0] }, t('projectUnknown') + ' (' + projectIds[0] + ')')
                  : null))),
        h(TeamRunSection, { t: t, draft: draft, set: set, commit: props.commit, teamId: props.teamId, teams: props.teams || [], packs: props.packs, pack: props.pack, onReloadPacks: props.onReloadPacks, bitsById: props.bitsById || {} }),
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' }, t('shortcuts')),
          h('ul', { className: 'dsh-team-help' },
            ['shortcutConnect', 'shortcutPan', 'shortcutZoom', 'shortcutMarquee', 'shortcutGroup', 'shortcutDelete', 'shortcutDuplicate', 'shortcutUndo'].map(function (key) {
              return h('li', { key: key }, t(key))
            })))
      )
    }

    /** Hint line for the packs state when the selected harness cannot be listed. */
    function packStateHint(t, packs, harnessId) {
      if (!harnessId) return t('noPackHint')
      if (!packs || packs.phase === 'loading' || packs.phase === 'idle') return t('packsLoading')
      if (packs.phase === 'error') return t('packsError') + (packs.error ? ' ' + packs.error : '')
      return tf(t, 'packMissingHint', { id: harnessId })
    }

    /**
     * Checkbox list over `options` (names) plus any already-selected name the
     * options lack (so stale picks can still be cleared).
     */
    function NameChecklist(props) {
      const selected = Array.isArray(props.selected) ? props.selected : []
      const names = props.options.map(function (option) { return option.name })
      const extra = selected.filter(function (name) { return names.indexOf(name) < 0 }).map(function (name) { return { name: name, description: '' } })
      const items = props.options.concat(extra)
      const full = typeof props.max === 'number' && selected.length >= props.max
      function toggle(name, checked) {
        const next = selected.filter(function (other) { return other !== name })
        if (checked) next.push(name)
        props.onChange(next)
      }
      return h('div', { className: 'dsh-team-launches', id: props.id },
        items.map(function (item) {
          const checked = selected.indexOf(item.name) >= 0
          return h('div', { key: item.name, title: item.description || undefined },
            h(Checkbox, {
              checked: checked,
              disabled: !checked && full,
              label: item.name,
              onChange: function (value) { toggle(item.name, value) },
            }))
        }))
    }

    /** Team-level runtime settings: lead, harness, workspace binding, rules, skills, requests (§11.1). */
    function TeamRunSection(props) {
      const t = props.t
      const draft = props.draft
      const set = props.set
      const pack = props.pack
      const packs = props.packs || { phase: 'idle', list: [], error: null }
      const entries = Array.isArray(draft.entry) ? draft.entry : []
      const workspace = asString(draft.workspaceDir).trim()
      const conflict = draft.bindWorkspace && workspace
        ? props.teams.find(function (other) { return other.id !== props.teamId && other.bindWorkspace === true && sameDir(other.workspaceDir, workspace) }) || null
        : null
      // Only orchestrator bits may lead a team (V5-CONTRACT.md §5.1).
      const bitsById = props.bitsById || {}
      const leadOptions = draft.members.filter(function (member) { return memberIsOrchestrator(member, bitsById) })
      const leadMember = draft.lead ? draft.members.find(function (member) { return member.id === draft.lead }) || null : null
      const leadKnown = !draft.lead || !!leadMember
      const leadInvalid = !!leadMember && !memberIsOrchestrator(leadMember, bitsById)

      function setEntries(next, coalesce) {
        props.commit(function (previous) { return Object.assign({}, previous, { entry: next }) }, coalesce || null)
      }
      function patchEntry(id, patch, field) {
        setEntries(entries.map(function (item) { return item.id === id ? Object.assign({}, item, patch) : item }), 'team:entry:' + id + ':' + field)
      }
      function addEntry() {
        if (entries.length >= MAX_ENTRY) return
        setEntries(entries.concat([{ id: freshId('p', indexBy(entries)), label: '', template: '' }]))
      }
      function removeEntry(id) {
        setEntries(entries.filter(function (item) { return item.id !== id }))
      }

      let packSummary = null
      if (pack) {
        packSummary = h('p', { className: 'dsh-team-summary', title: pack.sourceDir || undefined }, tf(t, 'packSummary', packStats(pack)))
      } else if (draft.harness) {
        packSummary = h('p', { className: 'dsh-bots-hint' }, packStateHint(t, packs, draft.harness))
      } else if (packs.phase === 'error') {
        packSummary = h('p', { className: 'dsh-bots-hint' }, t('packsError') + (packs.error ? ' ' + packs.error : ''))
      }
      const harnessOptions = packs.list.map(function (item) {
        return h('option', { key: item.id, value: item.id }, item.name === item.id ? item.id : item.name + ' (' + item.id + ')')
      })
      if (draft.harness && !pack) {
        harnessOptions.push(h('option', { key: 'missing:' + draft.harness, value: draft.harness }, tf(t, 'harnessUnknown', { id: draft.harness })))
      }

      return h(React.Fragment, null,
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' }, t('runSection')),
          h(Field, { label: t('leadLabel'), htmlFor: 'dsh-team-prop-lead', hint: t('leadHint') },
            h('select', {
              id: 'dsh-team-prop-lead', className: 'dsh-bots-select',
              value: leadKnown && !leadInvalid ? (draft.lead || '') : '',
              onChange: function (event) { set('lead', event.target.value || null) },
            },
              h('option', { value: '' }, t('leadNone')),
              leadOptions.map(function (member) { return h('option', { key: member.id, value: member.id }, memberName(member, bitsById)) }),
              leadInvalid ? h('option', { value: draft.lead }, memberName(leadMember, bitsById)) : null),
            leadInvalid ? h('p', { className: 'dsh-bots-warn', role: 'alert' }, t('leadInvalid')) : null,
            draft.members.length > 0 && leadOptions.length === 0 ? h('p', { className: 'dsh-bots-warn' }, t('noOrchestratorMembers')) : null),
          h(Field, { label: t('harnessLabel'), htmlFor: 'dsh-team-prop-harness' },
            h('select', {
              id: 'dsh-team-prop-harness', className: 'dsh-bots-select', value: draft.harness || '',
              onChange: function (event) { set('harness', event.target.value || null) },
            },
              h('option', { value: '' }, t('harnessNone')),
              harnessOptions),
            packSummary),
          h('div', { className: 'dsh-bots-field' },
            h(Switch, {
              checked: draft.bindWorkspace === true,
              label: t('bindWorkspace'),
              onChange: function (checked) { set('bindWorkspace', checked) },
            }),
            h('p', { className: 'dsh-bots-hint' }, t('bindWorkspaceHint')),
            draft.bindWorkspace && !workspace ? h('p', { className: 'dsh-bots-warn' }, t('bindWorkspaceNoDir')) : null,
            conflict ? h('p', { className: 'dsh-bots-warn' }, tf(t, 'bindWorkspaceConflict', { name: conflict.name })) : null),
          h(Field, { label: t('rulesLabel'), htmlFor: 'dsh-team-prop-rules', hint: t('rulesHint') },
            h('textarea', {
              id: 'dsh-team-prop-rules', className: 'dsh-bots-textarea dsh-team-textarea-sm', value: asString(draft.rules),
              maxLength: MAX_RULES, placeholder: t('rulesPlaceholder'),
              onChange: function (event) { set('rules', event.target.value) },
            }))),
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' }, t('teamSkills')),
          pack
            ? (pack.skills.length === 0 && (draft.skills || []).length === 0
              ? h('p', { className: 'dsh-bots-hint' }, t('packSkillsNone'))
              : h(React.Fragment, null,
                h(NameChecklist, { id: 'dsh-team-prop-skills', options: pack.skills, selected: draft.skills, onChange: function (next) { set('skills', next) } }),
                h('p', { className: 'dsh-bots-hint' }, t('teamSkillsHint'))))
            : ((draft.skills || []).length > 0
              ? h(NameChecklist, { id: 'dsh-team-prop-skills', options: [], selected: draft.skills, onChange: function (next) { set('skills', next) } })
              : h('p', { className: 'dsh-bots-hint' }, packStateHint(t, packs, draft.harness)))),
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' },
            h('span', null, t('entriesLabel') + ' (' + entries.length + ')'),
            h(Button, { variant: 'ghost', size: 'sm', disabled: entries.length >= MAX_ENTRY, onClick: addEntry }, h(PlusIcon, { size: 12 }), t('addEntry'))),
          h('p', { className: 'dsh-bots-hint' }, t('entriesHint')),
          entries.length === 0
            ? h('p', { className: 'dsh-bots-hint', style: { fontStyle: 'italic' } }, t('entriesEmpty'))
            : h('ul', { className: 'dsh-team-entries' }, entries.map(function (item, index) {
              const labelBad = !item.label.trim() && !!item.template.trim()
              const templateBad = !!item.label.trim() && !item.template.trim()
              return h('li', { key: item.id, className: 'dsh-team-entry' },
                h('div', { className: 'dsh-team-entry-head' },
                  h('input', {
                    className: 'dsh-bots-input', value: item.label, maxLength: MAX_ENTRY_LABEL,
                    placeholder: t('entryLabelPlaceholder'), 'aria-label': t('entriesLabel') + ' ' + (index + 1) + ': ' + t('label'),
                    'aria-invalid': labelBad ? 'true' : undefined,
                    onChange: function (event) { patchEntry(item.id, { label: event.target.value }, 'label') },
                  }),
                  h(IconButton, { label: t('removeEntry'), className: 'dsh-bots-icon-button-sm', onClick: function () { removeEntry(item.id) } }, h(TrashIcon, { size: 14 }))),
                h('textarea', {
                  className: 'dsh-bots-textarea', value: item.template, maxLength: MAX_ENTRY_TEMPLATE, spellCheck: false,
                  placeholder: t('entryTemplatePlaceholder'), 'aria-label': t('entriesLabel') + ' ' + (index + 1) + ': ' + t('sendTemplate'),
                  'aria-invalid': templateBad ? 'true' : undefined,
                  onChange: function (event) { patchEntry(item.id, { template: event.target.value }, 'template') },
                }))
            })))
      )
    }

    function ConnectionList(props) {
      const t = props.t
      if (props.items.length === 0) return null
      return h('div', { className: 'dsh-team-section' },
        h('h3', { className: 'dsh-team-section-title' }, props.title),
        h('ul', { className: 'dsh-team-conn' }, props.items.map(function (item) {
          const other = props.nodesById[item.otherId]
          return h('li', { key: item.edge.id },
            h('button', { type: 'button', className: 'dsh-team-conn-item', onClick: function () { props.onSelect(item.edge.id) } },
              h('span', { 'aria-hidden': 'true' }, props.arrow),
              h('span', { className: 'dsh-team-conn-name' }, other ? (other.label || t('untitled')) : item.otherId),
              item.edge.label ? h('span', { className: 'dsh-team-conn-label' }, item.edge.label) : null))
        })))
    }

    function NodeInspector(props) {
      const t = props.t
      const node = props.node
      const labelRef = React.useRef(null)
      const teamRefRef = React.useRef(null)
      const otherTeams = Array.isArray(props.otherTeams) ? props.otherTeams : []
      const teamsById = props.teamsById || {}
      React.useEffect(function () {
        if (!props.focusToken) return
        // A fresh team node asks for its team first; everything else starts at the title.
        if (node.type === 'team' && !node.teamRef && teamRefRef.current) {
          try { teamRefRef.current.focus() } catch (error) { /* best effort */ }
          return
        }
        if (labelRef.current) {
          try {
            labelRef.current.focus()
            labelRef.current.select()
          } catch (error) { /* best effort */ }
        }
      }, [props.focusToken])

      function pickTeam(teamRef) {
        const target = teamRef ? teamsById[teamRef] || null : null
        const previous = node.teamRef ? teamsById[node.teamRef] || null : null
        const patch = { teamRef: teamRef || null }
        const label = node.label.trim()
        // Follow the team name while the title is still a placeholder.
        if (target && (!label || label === props.t('nodeTeamDefault') || (previous && label === previous.name))) patch.label = target.name
        props.commit(function (current) { return patchNode(current, node.id, patch) })
      }

      function set(patch, field) {
        props.commit(function (previous) { return patchNode(previous, node.id, patch) }, 'node:' + node.id + ':' + field)
      }

      function changeType(type) {
        const patch = { type: type }
        if (type !== 'group' && type !== 'note') {
          patch.w = undefined
          patch.h = undefined
        } else {
          const size = NODE_SIZE[type]
          patch.w = size[0]
          patch.h = size[1]
        }
        if (type !== 'step') patch.memberId = undefined
        else patch.memberId = node.memberId || null
        if (type !== 'team') patch.teamRef = undefined
        else patch.teamRef = node.teamRef || null
        props.commit(function (previous) { return patchNode(previous, node.id, patch) })
      }

      const outgoing = []
      const incoming = []
      props.draft.flow.edges.forEach(function (edge) {
        if (edge.from === node.id) outgoing.push({ edge: edge, otherId: edge.to })
        if (edge.to === node.id) incoming.push({ edge: edge, otherId: edge.from })
      })
      const typeColor = nodeColor(node, props.membersById, props.catalog)

      return h(React.Fragment, null,
        h('section', { className: 'dsh-team-section' },
          h('h2', { className: 'dsh-team-section-title' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h('span', { className: 'dsh-team-type-icon', style: { '--node-color': typeColor, '--node-tint': hexAlpha(typeColor, 0.14) }, 'aria-hidden': 'true' }, typeIcon(node.type, 12)),
              t('nodeProps'))),
          h(Field, { label: t('type'), htmlFor: 'dsh-node-type' },
            h('select', { id: 'dsh-node-type', className: 'dsh-bots-select', value: node.type, onChange: function (event) { changeType(event.target.value) } },
              NODE_TYPES.map(function (type) { return h('option', { key: type, value: type }, t(TYPE_LABEL_KEY[type])) }))),
          h(Field, { label: t('label'), htmlFor: 'dsh-node-label' },
            h('input', { id: 'dsh-node-label', ref: labelRef, className: 'dsh-bots-input', value: node.label, maxLength: 200, onChange: function (event) { set({ label: event.target.value }, 'label') } })),
          node.type === 'step'
            ? h(Field, { label: t('member'), htmlFor: 'dsh-node-member' },
              h('select', { id: 'dsh-node-member', className: 'dsh-bots-select', value: node.memberId || '', onChange: function (event) { set({ memberId: event.target.value || null }, 'member') } },
                h('option', { value: '' }, t('noMember')),
                props.draft.members.map(function (member) { return h('option', { key: member.id, value: member.id }, memberName(member, props.bitsById)) })))
            : null,
          node.type === 'team'
            ? h(Field, {
              label: t('teamNodeTarget'), htmlFor: 'dsh-node-team',
              hint: otherTeams.length === 0 ? t('teamNodeNoOthers') : t('teamNodeHint'),
            },
              h('select', {
                id: 'dsh-node-team', ref: teamRefRef, className: 'dsh-bots-select', value: node.teamRef || '',
                onChange: function (event) { pickTeam(event.target.value) },
              },
                h('option', { value: '' }, t('teamNodePick')),
                otherTeams.map(function (item) { return h('option', { key: item.id, value: item.id }, (item.emoji ? item.emoji + ' ' : '') + item.name) }),
                node.teamRef && !otherTeams.some(function (item) { return item.id === node.teamRef })
                  ? h('option', { value: node.teamRef }, teamsById[node.teamRef] ? teamsById[node.teamRef].name : t('teamNodeMissing') + ' (' + node.teamRef + ')')
                  : null))
            : null,
          node.type === 'group' || node.type === 'note'
            ? h(Field, { label: t('color'), htmlFor: 'dsh-node-color' },
              h('div', { className: 'dsh-bots-palette', id: 'dsh-node-color' }, GROUP_COLORS.concat([TYPE_COLOR.note]).map(function (color) {
                return h('button', {
                  key: color, type: 'button', className: 'dsh-bots-swatch', style: { backgroundColor: color },
                  'aria-pressed': typeColor === color ? 'true' : 'false', 'aria-label': color,
                  onClick: function () { set({ color: color }, 'color') },
                })
              })))
            : null,
          h(Field, { label: t('detail'), htmlFor: 'dsh-node-detail', hint: node.type === 'step' ? t('detailHint') : null },
            h('textarea', { id: 'dsh-node-detail', className: 'dsh-bots-textarea dsh-team-textarea-sm', value: node.detail, maxLength: 4000, onChange: function (event) { set({ detail: event.target.value }, 'detail') } })),
          h('div', { className: 'dsh-team-inline' },
            h(Button, { variant: 'outline', size: 'sm', onClick: props.onDuplicate }, h(CopyIcon, { size: 13 }), t('duplicate')),
            h(Button, { variant: 'ghost', size: 'sm', className: 'dsh-bots-button-danger', onClick: props.onDelete }, h(TrashIcon, { size: 13 }), t('remove')))),
        outgoing.length === 0 && incoming.length === 0 && node.type !== 'group' && node.type !== 'note'
          ? h('p', { className: 'dsh-bots-hint' }, t('noConnections'))
          : null,
        h(ConnectionList, { t: t, title: t('outgoing'), arrow: '→', items: outgoing, nodesById: props.nodesById, onSelect: props.onSelectEdge }),
        h(ConnectionList, { t: t, title: t('incoming'), arrow: '←', items: incoming, nodesById: props.nodesById, onSelect: props.onSelectEdge })
      )
    }

    function EdgeInspector(props) {
      const t = props.t
      const edge = props.edge
      const from = props.nodesById[edge.from]
      const to = props.nodesById[edge.to]
      function set(patch, field) {
        props.commit(function (previous) { return patchEdge(previous, edge.id, patch) }, field ? 'edge:' + edge.id + ':' + field : null)
      }
      return h('section', { className: 'dsh-team-section' },
        h('h2', { className: 'dsh-team-section-title' }, t('edgeProps')),
        h('div', { className: 'dsh-team-conn' },
          h('button', { type: 'button', className: 'dsh-team-conn-item', onClick: function () { props.onSelectNode(edge.from) } },
            h('span', { className: 'dsh-team-conn-label' }, t('edgeFrom')),
            h('span', { className: 'dsh-team-conn-name' }, from ? (from.label || t('untitled')) : edge.from)),
          h('button', { type: 'button', className: 'dsh-team-conn-item', onClick: function () { props.onSelectNode(edge.to) } },
            h('span', { className: 'dsh-team-conn-label' }, t('edgeTo')),
            h('span', { className: 'dsh-team-conn-name' }, to ? (to.label || t('untitled')) : edge.to))),
        h(Field, { label: t('edgeLabel'), htmlFor: 'dsh-edge-label' },
          h('input', { id: 'dsh-edge-label', className: 'dsh-bots-input', value: edge.label, maxLength: 120, placeholder: t('edgeLabelPlaceholder'), onChange: function (event) { set({ label: event.target.value }, 'label') } })),
        h(Field, { label: t('edgeKind'), htmlFor: 'dsh-edge-kind' },
          h('select', { id: 'dsh-edge-kind', className: 'dsh-bots-select', value: edge.kind, onChange: function (event) { set({ kind: event.target.value }) } },
            EDGE_KINDS.map(function (kind) { return h('option', { key: kind, value: kind }, t(EDGE_KIND_KEY[kind])) }))),
        h('div', { className: 'dsh-team-inline' },
          h(Button, { variant: 'outline', size: 'sm', onClick: function () { set({ from: edge.to, to: edge.from }) } }, h(SwapIcon, { size: 13 }), t('reverse')),
          h(Button, { variant: 'ghost', size: 'sm', className: 'dsh-bots-button-danger', onClick: props.onDelete }, h(TrashIcon, { size: 13 }), t('remove')))
      )
    }

    /**
     * "Adicionar bit": pick one existing bit (grouped by catalog group) to add
     * as a team member. Bits are created on the Bits tab (V5-CONTRACT.md §8).
     */
    function AddMemberDialog(props) {
      const t = props.t
      const lang = props.lang
      const catalog = props.catalog
      const bits = Array.isArray(props.bits) ? props.bits : []
      const [choice, setChoice] = React.useState(bits.length > 0 ? bits[0].id : '')
      const selectRef = React.useRef(null)
      const chosen = bits.find(function (bit) { return bit.id === choice }) || null
      const chosenCharacter = bitCharacter(chosen, catalog)

      // Group by catalog group, in catalog order; unknown/legacy groups last.
      const sections = []
      const byGroup = {}
      function sectionFor(id) {
        if (!byGroup[id]) {
          byGroup[id] = { id: id, label: id, bits: [] }
          sections.push(byGroup[id])
        }
        return byGroup[id]
      }
      catalog.groups.forEach(function (group) {
        const section = sectionFor(group.id)
        section.label = lang === 'en' ? group.label.en : group.label.pt
      })
      const other = sectionFor('__other')
      other.label = t('otherGroup')
      bits.forEach(function (bit) {
        const character = bitCharacter(bit, catalog)
        sectionFor(character && character.group ? character.group : '__other').bits.push(bit)
      })
      const visible = sections.filter(function (section) { return section.bits.length > 0 })

      const footer = [
        h('button', { key: 'cancel', type: 'button', className: 'dsh-bots-button dsh-bots-button-outline', onClick: props.onCancel }, t('cancel')),
        h('button', {
          key: 'add',
          type: 'button',
          className: 'dsh-bots-button dsh-bots-button-primary',
          disabled: !chosen,
          onClick: function () { if (chosen) props.onPick(chosen) },
        }, t('addMemberConfirm')),
      ]

      let body
      if (props.phase === 'loading') {
        body = h('p', { className: 'dsh-bots-hint', role: 'status' }, t('loading'))
      } else if (bits.length === 0) {
        body = h('div', { className: 'dsh-bots-state' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(BotsGlyph, { size: 36 })),
          h('p', { className: 'dsh-bots-state-title' }, t('addMemberNoBits')),
          h('p', { className: 'dsh-bots-state-text' }, t('addMemberNoBitsHint')))
      } else {
        body = h(React.Fragment, null,
          h('p', { className: 'dsh-bots-hint' }, t('addMemberHint')),
          h(Field, { label: t('addMemberPick'), htmlFor: 'dsh-add-member-bit' },
            h('select', {
              id: 'dsh-add-member-bit',
              ref: selectRef,
              className: 'dsh-bots-select',
              value: choice,
              onChange: function (event) { setChoice(event.target.value) },
            }, visible.map(function (section) {
              return h('optgroup', { key: section.id, label: section.label }, section.bits.map(function (bit) {
                const character = bitCharacter(bit, catalog)
                return h('option', { key: bit.id, value: bit.id }, character ? bit.name + ' · ' + character.name : bit.name)
              }))
            }))),
          chosen
            ? h('div', { className: 'dsh-bots-bit-hero' },
              h(BitAvatar, { bit: avatarBitOf(chosen, catalog), size: 64, emoji: chosen.emoji, color: chosen.color }),
              h('div', { className: 'dsh-bots-bit-hero-text' },
                h('p', { className: 'dsh-bots-bit-hero-role' }, chosen.name),
                h('p', { className: 'dsh-bots-hint' }, chosenCharacter
                  ? chosenCharacter.name + ' · ' + groupLabelOf(catalog, chosenCharacter.group, lang, t)
                  : t('noCharacter')),
                h('div', { className: 'dsh-team-badges' },
                  h(Badge, {
                    dot: false,
                    tone: chosen.isOrchestrator === true ? 'info' : 'neutral',
                    label: chosen.isOrchestrator === true ? t('orchestrator') : t('worker'),
                  }),
                  bitRouteText(chosen, props.models)
                    ? h(Badge, { dot: false, label: bitRouteText(chosen, props.models) })
                    : null)))
            : null)
      }

      return h(Modal, { t: t, title: t('addMemberTitle'), initialFocusRef: selectRef, onClose: props.onCancel, footer: footer },
        body)
    }

    /** Member editor: the bit reference (read-only route) + team-scoped fields (§8). */
    function MemberInspector(props) {
      const t = props.t
      const member = props.member
      if (!member) return null
      const bitsById = props.bitsById || {}
      const models = props.models || emptyModels('idle')
      const catalog = props.catalog
      const bit = memberBit(member, bitsById)
      const character = bitCharacter(bit, catalog)
      const bitList = props.bits && Array.isArray(props.bits.list) ? props.bits.list : []
      const others = props.members.filter(function (item) { return item.id !== member.id })
      const routeText = memberRouteText(member, bitsById, models)
      const leadEligible = memberIsOrchestrator(member, bitsById)

      function set(patch, field) {
        props.commit(function (previous) { return patchMember(previous, member.id, patch) }, field ? 'member:' + member.id + ':' + field : null)
      }
      function toggleLaunch(id, checked) {
        const next = member.launches.filter(function (other) { return other !== id })
        if (checked) next.push(id)
        set({ launches: next })
      }
      function makeLead() {
        if (!leadEligible) return
        props.commit(function (previous) { return previous.lead === member.id ? previous : Object.assign({}, previous, { lead: member.id }) })
      }
      function changeBit(bitId) {
        if (!bitId || bitId === member.bitId) return
        props.onChangeBit(member.id, bitId)
      }

      // Group the bit options by catalog group (same order as the add dialog).
      const bitGroups = []
      const bitGroupMap = {}
      function bitGroupFor(id) {
        if (!bitGroupMap[id]) {
          bitGroupMap[id] = { id: id, label: id, bits: [] }
          bitGroups.push(bitGroupMap[id])
        }
        return bitGroupMap[id]
      }
      catalog.groups.forEach(function (group) {
        const section = bitGroupFor(group.id)
        section.label = props.lang === 'en' ? group.label.en : group.label.pt
      })
      const otherBits = bitGroupFor('__other')
      otherBits.label = t('otherGroup')
      bitList.forEach(function (record) {
        const recordCharacter = bitCharacter(record, catalog)
        bitGroupFor(recordCharacter && recordCharacter.group ? recordCharacter.group : '__other').bits.push(record)
      })
      const bitOptions = bitGroups.filter(function (group) { return group.bits.length > 0 }).map(function (group) {
        return h('optgroup', { key: group.id, label: group.label }, group.bits.map(function (record) {
          return h('option', { key: record.id, value: record.id }, record.name)
        }))
      })
      if (member.bitId && !bit) bitOptions.push(h('option', { key: 'missing', value: member.bitId }, tf(t, 'memberBitMissing', { id: member.bitId })))

      const pack = props.pack || null
      const otherTeams = Array.isArray(props.otherTeams) ? props.otherTeams : []
      const teamsById = props.teamsById || {}
      const skills = Array.isArray(member.skills) ? member.skills : []
      const mcp = Array.isArray(member.mcp) ? member.mcp : []
      const refListed = !member.teamRef || otherTeams.some(function (item) { return item.id === member.teamRef })

      let skillsControl
      if (pack && (pack.skills.length > 0 || skills.length > 0)) {
        skillsControl = h(NameChecklist, { id: 'dsh-member-skills', options: pack.skills, selected: skills, onChange: function (next) { set({ skills: next }) } })
      } else if (pack) {
        skillsControl = h('p', { className: 'dsh-bots-hint' }, t('packSkillsNone'))
      } else if (skills.length > 0) {
        skillsControl = h(React.Fragment, null,
          h(NameChecklist, { id: 'dsh-member-skills', options: [], selected: skills, onChange: function (next) { set({ skills: next }) } }),
          h('p', { className: 'dsh-bots-hint' }, packStateHint(t, props.packs, props.harnessId)))
      } else {
        skillsControl = h('p', { className: 'dsh-bots-hint' }, packStateHint(t, props.packs, props.harnessId))
      }

      let mcpControl
      const mcpOptions = pack ? pack.mcp.map(function (name) { return { name: name, description: '' } }) : []
      if (mcpOptions.length > 0 || mcp.length > 0) {
        mcpControl = h(NameChecklist, { id: 'dsh-member-mcp', options: mcpOptions, selected: mcp, max: MAX_MEMBER_MCP, onChange: function (next) { set({ mcp: next.slice(0, MAX_MEMBER_MCP) }) } })
      } else {
        mcpControl = h('p', { className: 'dsh-bots-hint' }, pack ? t('memberMcpNone') : (props.harnessId ? packStateHint(t, props.packs, props.harnessId) : t('packNeeded')))
      }

      return h('section', { className: 'dsh-team-section' },
        h('h2', { className: 'dsh-team-section-title' }, t('memberProps')),
        h('div', { className: 'dsh-bots-bit-hero' },
          h(BitAvatar, { bit: avatarBitOf(bit, catalog), size: 64, emoji: bit ? bit.emoji : '🤖', color: bit ? bit.color : TYPE_COLOR.end }),
          h('div', { className: 'dsh-bots-bit-hero-text' },
            h('p', { className: 'dsh-bots-bit-hero-role' }, bit ? bit.name : (member.bitId || t('memberBitMissing'))),
            character ? h('p', { className: 'dsh-bots-hint' }, character.name + ' · ' + groupLabelOf(catalog, character.group, props.lang, t)) : null,
            h('div', { className: 'dsh-team-badges' },
              h(Badge, {
                dot: false,
                tone: bit && bit.isOrchestrator === true ? 'info' : 'neutral',
                label: bit && bit.isOrchestrator === true ? t('orchestrator') : t('worker'),
              }),
              routeText ? h(Badge, { dot: false, label: routeText, title: t('memberRoute') }) : null),
            h('p', { className: 'dsh-bots-hint' }, tf(t, 'memberSteps', { n: props.uses })),
            h('p', { className: 'dsh-bots-hint' }, t('memberReadOnlyHint')))),
        h('div', { className: 'dsh-team-lead-row' },
          props.isLead
            ? h(Badge, { tone: 'info', dot: false, label: h(React.Fragment, null, h(CrownIcon, { size: 12 }), t('leadBadge')), title: t('leadHint') })
            : h(Button, { variant: 'outline', size: 'sm', disabled: !leadEligible, title: leadEligible ? t('leadHint') : t('leadNotOrchestrator'), onClick: makeLead }, h(CrownIcon, { size: 13 }), t('makeLead')),
          !leadEligible ? h('p', { className: 'dsh-bots-hint' }, t('leadNotOrchestrator')) : null),
        h(Field, { label: t('memberBit'), htmlFor: 'dsh-member-bit', hint: t('memberBitHint') },
          h('select', {
            id: 'dsh-member-bit', className: 'dsh-bots-select', value: member.bitId || '',
            onChange: function (event) { changeBit(event.target.value) },
          },
            !member.bitId ? h('option', { value: '' }, t('noCharacter')) : null,
            bitOptions),
          bitList.length === 0 ? h('p', { className: 'dsh-bots-warn' }, t('addMemberNoBitsHint')) : null),
        h(Field, { label: t('memberRole'), htmlFor: 'dsh-member-role' },
          h('input', { id: 'dsh-member-role', className: 'dsh-bots-input', value: member.role, maxLength: 200, placeholder: t('memberRolePlaceholder'), onChange: function (event) { set({ role: event.target.value }, 'role') } })),
        h(Field, { label: t('memberAccess'), htmlFor: 'dsh-member-access' },
          h('select', { id: 'dsh-member-access', className: 'dsh-bots-select', value: member.access, onChange: function (event) { set({ access: event.target.value === 'read' ? 'read' : 'write' }) } },
            h('option', { value: 'write' }, t('accessWrite')),
            h('option', { value: 'read' }, t('accessRead')))),
        h(Field, { label: t('memberTeamRef'), htmlFor: 'dsh-member-teamref', hint: member.teamRef ? t('memberTeamRefHint') : null },
          h('select', {
            id: 'dsh-member-teamref', className: 'dsh-bots-select', value: member.teamRef || '',
            onChange: function (event) { set({ teamRef: event.target.value || null }) },
          },
            h('option', { value: '' }, t('memberTeamRefNone')),
            otherTeams.map(function (item) { return h('option', { key: item.id, value: item.id }, (item.emoji ? item.emoji + ' ' : '') + item.name) }),
            refListed ? null : h('option', { value: member.teamRef }, teamsById[member.teamRef] ? teamsById[member.teamRef].name : t('teamNodeMissing') + ' (' + member.teamRef + ')'))),
        h(Field, { label: t('memberLaunches'), htmlFor: 'dsh-member-launches' },
          others.length === 0
            ? h('p', { className: 'dsh-bots-hint' }, t('memberLaunchesNone'))
            : h('div', { className: 'dsh-team-launches', id: 'dsh-member-launches' }, others.map(function (other) {
              return h(Checkbox, {
                key: other.id,
                checked: member.launches.indexOf(other.id) >= 0,
                label: memberName(other, bitsById),
                onChange: function (checked) { toggleLaunch(other.id, checked) },
              })
            }))),
        h(Field, { label: t('memberSkills'), htmlFor: 'dsh-member-skills', hint: pack && pack.skills.length > 0 ? t('memberSkillsHint') : null }, skillsControl),
        h(Field, { label: t('memberMcp'), htmlFor: 'dsh-member-mcp', hint: mcpOptions.length > 0 ? t('memberMcpHint') : null }, mcpControl),
        h('div', { className: 'dsh-team-inline' },
          h(Button, { variant: 'ghost', size: 'sm', className: 'dsh-bots-button-danger', onClick: props.onRemove }, h(TrashIcon, { size: 13 }), t('removeMember')))
      )
    }

    /* ------------------------------------------------------------------ */
    /* Page                                                               */
    /* ------------------------------------------------------------------ */

    function BotsPage(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT
      const openSession = typeof props.openSession === 'function' ? props.openSession : null
      const usePanelInfo = typeof props.usePanelInfo === 'function' ? props.usePanelInfo : useAlwaysActivePanelInfo
      const panelActive = usePanelInfo(selectPanelActive)

      const [data, setData] = React.useState(function () {
        return { phase: 'loading', bits: [], byId: {}, error: null }
      })
      const [models, setModels] = React.useState(function () { return emptyModels('loading') })
      // Teams are only read for the orchestrator cards ("Líder em: …").
      const [teams, setTeams] = React.useState([])
      const [dialog, setDialog] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const [catalog, setCatalog] = React.useState(function () { return emptyCatalog('loading') })
      const [tab, setTabState] = React.useState(readStoredTab)
      const setTab = React.useCallback(function (next) {
        setTabState(next)
        storeTab(next)
      }, [])
      const lang = t('lang') === 'en' ? 'en' : 'pt'

      const aliveRef = React.useRef(true)
      const loadedRef = React.useRef(false)
      const inFlightRef = React.useRef(false)
      const toastSeqRef = React.useRef(0)

      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false }
      }, [])

      const showToast = React.useCallback(function (tone, text) {
        toastSeqRef.current += 1
        setToast({ toastKey: toastSeqRef.current, tone: tone, text: text })
      }, [])

      const hideToast = React.useCallback(function () { setToast(null) }, [])

      // The bit catalog ships with the bundle: load it once per page mount.
      const loadCatalog = React.useCallback(function () {
        setCatalog(function (previous) {
          return { phase: 'loading', groups: previous.groups, bits: previous.bits, byId: previous.byId, error: null }
        })
        api.catalog().then(function (data) {
          if (!aliveRef.current) return
          setCatalog({
            phase: data.bits.length > 0 ? 'ready' : 'error',
            groups: data.groups,
            bits: data.bits,
            byId: data.byId,
            error: data.error,
          })
        }, function (error) {
          if (!aliveRef.current) return
          setCatalog(function (previous) {
            return { phase: 'error', groups: previous.groups, bits: previous.bits, byId: previous.byId, error: describeError(error) }
          })
        })
      }, [])

      React.useEffect(function () {
        loadCatalog()
      }, [loadCatalog])

      // Model catalog: feeds the card route labels and the editor selects (§1).
      const loadModels = React.useCallback(function () {
        setModels(function (previous) {
          return { phase: previous.list.length > 0 ? 'ready' : 'loading', list: previous.list, byId: previous.byId, error: null }
        })
        return api.models().then(function (payload) {
          if (!aliveRef.current) return
          setModels({ phase: 'ready', list: payload.list, byId: payload.byId, error: payload.error })
        }, function (error) {
          if (!aliveRef.current) return
          setModels(function (previous) {
            return { phase: 'error', list: previous.list, byId: previous.byId, error: requestErrorText(error, t) }
          })
        })
      }, [t])

      React.useEffect(function () {
        loadModels()
      }, [loadModels])

      const load = React.useCallback(async function (quiet) {
        if (inFlightRef.current) return
        inFlightRef.current = true
        if (quiet !== true) {
          setData(function (previous) {
            return { phase: previous.bits.length > 0 ? 'ready' : 'loading', bits: previous.bits, byId: previous.byId, error: null }
          })
        }
        try {
          // Teams are optional context: a Host without them still renders the bits.
          const [payload, teamList] = await Promise.all([
            api.list(),
            teamsApi.list().then(function (list) { return list }, function () { return null }),
          ])
          if (!aliveRef.current) return
          loadedRef.current = true
          if (teamList) setTeams(teamList)
          setData({ phase: 'ready', bits: payload.bits, byId: payload.byId, error: null })
        } catch (error) {
          if (!aliveRef.current) return
          if (quiet !== true) {
            setData(function (previous) {
              return { phase: previous.bits.length > 0 ? 'ready' : 'error', bits: previous.bits, byId: previous.byId, error: describeError(error) }
            })
          } else {
            console.warn('[bits] background refresh failed:', describeError(error))
          }
        } finally {
          inFlightRef.current = false
        }
      }, [])

      React.useEffect(function () {
        if (!panelActive || tab !== 'bots') return undefined
        load(loadedRef.current)
      }, [panelActive, load, tab])

      function openCreate() {
        setDialog({ kind: 'form', bot: null })
      }

      function openEdit(bit) {
        setDialog({ kind: 'form', bot: bit })
      }

      function openDelete(bit) {
        setDialog({ kind: 'delete', bot: bit })
      }

      function openRun(bit) {
        setDialog({ kind: 'run', bit: bit })
      }

      function closeDialog() {
        setDialog(null)
      }

      async function saveBit(fields) {
        // `fields` is already the FormDialog payload (formPayload ran there).
        if (dialog && dialog.bot) {
          await api.update(dialog.bot.id, fields)
          setDialog(null)
          showToast('success', t('saved'))
        } else {
          await api.create(fields)
          setDialog(null)
          showToast('success', t('created'))
        }
        await load(true)
      }

      async function confirmDelete(deleteFiles) {
        if (!dialog || !dialog.bot) return
        const result = await api.remove(dialog.bot.id, deleteFiles)
        setDialog(null)
        showToast('success', result.workspaceRemoved ? t('deletedWorkspace') : t('deleted'))
        await load(true)
      }

      async function runBit(bit, request, readOnly) {
        return api.run(bit.id, request, readOnly)
      }

      async function handleRefresh() {
        if (refreshing) return
        setRefreshing(true)
        try {
          await Promise.all([load(false), loadModels()])
        } finally {
          setRefreshing(false)
        }
      }

      /** Teams whose lead member references this bit (orchestrator cards). */
      function teamsLedBy(bit) {
        return teams.filter(function (team) {
          if (!team.lead) return false
          const lead = team.members.find(function (member) { return member.id === team.lead })
          return !!lead && lead.bitId === bit.id
        })
      }

      const bits = data.bits
      const phase = data.phase
      const toolbar = h('div', { className: 'dsh-bots-toolbar' },
        h(IconButton, {
          label: refreshing ? t('refreshing') : t('refresh'),
          disabled: refreshing,
          onClick: handleRefresh,
        }, h(RefreshIcon, { size: 16 })),
        h(Button, {
          variant: 'primary',
          onClick: openCreate,
        }, h(PlusIcon, { size: 14 }), t('newBot'))
      )

      let body = null
      if (phase === 'loading') {
        body = h(React.Fragment, null,
          h('p', { className: 'dsh-bots-visually-hidden', role: 'status' }, t('loading')),
          h('ul', { className: 'dsh-bots-cards', 'aria-hidden': 'true' },
            [0, 1, 2].map(function (index) {
              return h('li', { key: 'skeleton-' + index, className: 'dsh-bots-skeleton' },
                h('div', { className: 'dsh-bots-skeleton-head' },
                  h('div', { className: 'dsh-bots-skeleton-bar dsh-bots-skeleton-avatar' }),
                  h('div', { className: 'dsh-bots-skeleton-col' },
                    h('div', { className: 'dsh-bots-skeleton-bar dsh-bots-skeleton-bar-short' }),
                    h('div', { className: 'dsh-bots-skeleton-bar dsh-bots-skeleton-bar-wide' })
                  )
                ),
                h('div', { className: 'dsh-bots-skeleton-bar' }),
                h('div', { className: 'dsh-bots-skeleton-bar dsh-bots-skeleton-bar-wide' })
              )
            })
          )
        )
      } else if (phase === 'error' && bits.length === 0) {
        body = h('div', { className: 'dsh-bots-state dsh-bots-state-error' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(WarningIcon, { size: 28 })),
          h('p', { className: 'dsh-bots-state-title' }, t('error')),
          data.error ? h('p', { className: 'dsh-bots-state-text' }, data.error) : null,
          h(Button, { variant: 'outline', onClick: handleRefresh }, t('retry'))
        )
      } else if (bits.length === 0) {
        body = h('div', { className: 'dsh-bots-state' },
          catalog.byId[MASCOT_ID]
            ? h(BitAvatar, { bit: catalog.byId[MASCOT_ID], size: 112, eager: true })
            : h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(BotsGlyph, { size: 40 })),
          h('p', { className: 'dsh-bots-state-title' }, t('empty')),
          h('p', { className: 'dsh-bots-state-text' }, t('emptyHint')),
          h(Button, { variant: 'primary', onClick: openCreate }, h(PlusIcon, { size: 14 }), t('newBot'))
        )
      } else {
        body = h(React.Fragment, null,
          data.error
            ? h('div', { className: 'dsh-bots-banner', role: 'alert' },
              h('span', { className: 'dsh-bots-banner-text' }, t('error') + ' ' + data.error),
              h(Button, { variant: 'outline', size: 'sm', onClick: handleRefresh }, t('retry')))
            : null,
          h('ul', { className: 'dsh-bots-cards' },
            bits.map(function (bit) {
              return h(BitCard, {
                key: bit.id,
                bit: bit,
                models: models,
                catalog: catalog,
                lang: lang,
                t: t,
                leadTeams: bit.isOrchestrator === true ? teamsLedBy(bit) : [],
                onRun: openRun,
                onEdit: openEdit,
                onDelete: openDelete,
                onOpenTeams: function () { setTab('teams') },
              })
            })
          )
        )
      }

      let dialogNode = null
      if (dialog && dialog.kind === 'form') {
        dialogNode = h(FormDialog, {
          key: 'form',
          t: t,
          bot: dialog.bot,
          lang: lang,
          catalog: catalog,
          models: models,
          onRetryCatalog: loadCatalog,
          onCancel: closeDialog,
          onSubmit: saveBit,
        })
      } else if (dialog && dialog.kind === 'delete') {
        dialogNode = h(DeleteDialog, {
          key: 'delete',
          t: t,
          bot: dialog.bot,
          onCancel: closeDialog,
          onConfirm: confirmDelete,
        })
      } else if (dialog && dialog.kind === 'run') {
        dialogNode = h(RunBitDialog, {
          key: 'run-' + dialog.bit.id,
          t: t,
          bit: dialog.bit,
          models: models,
          onClose: closeDialog,
          onRun: runBit,
        })
      }

      const tabsNode = h(PageTabs, { t: t, tab: tab, onChange: setTab })
      const toastNode = toast ? h(Toast, {
        key: 'toast-' + toast.toastKey,
        toastKey: toast.toastKey,
        tone: toast.tone,
        text: toast.text,
        onDone: hideToast,
      }) : null

      if (tab === 'teams') {
        return h('div', { className: 'dsh-bots-root', style: { height: '100%' } },
          h('style', { key: 'dsh-bots-styles' }, STYLES + TEAM_STYLES),
          h(TeamsView, {
            t: t,
            lang: lang,
            catalog: catalog,
            onRetryCatalog: loadCatalog,
            showToast: showToast,
            openSession: openSession,
            tabs: tabsNode,
            onSelectTab: setTab,
          }),
          toastNode)
      }

      if (tab === 'projects') {
        return h('div', { className: 'dsh-bots-root', style: { height: '100%' } },
          h('style', { key: 'dsh-bots-styles' }, STYLES + TEAM_STYLES),
          h(ProjectsView, {
            t: t,
            lang: lang,
            catalog: catalog,
            onRetryCatalog: loadCatalog,
            showToast: showToast,
            openSession: openSession,
            tabs: tabsNode,
          }),
          toastNode)
      }

      // One root carries the theme variables for the page AND for the dialog
      // and toast layers, which render as siblings of the scrolling page.
      return h('div', { className: 'dsh-bots-root', style: { height: '100%' } },
        h('style', { key: 'dsh-bots-styles' }, STYLES + TEAM_STYLES),
        h('div', { className: 'dsh-bots-page' },
          h('div', { className: 'dsh-bots-inner' },
            h('header', { className: 'dsh-bots-head' },
              h('div', { className: 'dsh-bots-heading' },
                h('h1', { className: 'dsh-bots-title' }, t('title')),
                h('p', { className: 'dsh-bots-intro' }, t('subtitle'))
              ),
              toolbar
            ),
            h('div', { className: 'dsh-bots-tabrow' }, tabsNode),
            h('div', { className: 'dsh-bots-body', 'aria-busy': phase === 'loading' ? 'true' : undefined }, body)
          )
        ),
        dialogNode,
        toast ? h(Toast, {
          key: 'toast-' + toast.toastKey,
          toastKey: toast.toastKey,
          tone: toast.tone,
          text: toast.text,
          onDone: hideToast,
        }) : null
      )
    }

    /* ------------------------------------------------------------------ */
    /* Plugin module                                                      */
    /* ------------------------------------------------------------------ */

    /** Read a service defensively: an absent one degrades to `null`. */
    function readService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const value = ctx.get(name)
          if (value) return value
        }
      } catch (error) {
        return null
      }
      try {
        const direct = ctx ? ctx[name] : null
        return direct || null
      } catch (error) {
        return null
      }
    }

    /** Open an existing session through the workspace service (mission from a flow). */
    function makeOpenSession(ctx, t) {
      /**
       * @param sessionId - Harness session id created by `POST /api/bots.teams.run`.
       */
      return function openBitsSession(sessionId) {
        if (typeof sessionId !== 'string' || !sessionId) throw new Error(t('sendOpenFailed'))
        const service = readService(ctx, 'uiWorkspace')
        if (!service || typeof service.openSession !== 'function') throw new Error(t('sendOpenFailed'))
        return service.openSession(sessionId)
      }
    }

    /** Services the registrations need; `uiWorkspace` opens a started mission. */
    const inject = ['slots', 'locale', 'layout', 'uiWorkspace']

    /**
     * Register the sidebar entry and the main page.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      if (!ctx || !ctx.locale || !ctx.slots) return
      ctx.effect(function () {
        return ctx.locale.register(NS, { en: EN, pt: PT, 'pt-BR': PT })
      }, 'dsh-bots: dictionaries')
      const t = ctx.locale.bind(NS)
      let layout = null
      try {
        layout = ctx.layout || null
      } catch (error) {
        layout = null
      }
      const panelInfo = layout && layout.panelInfo ? layout.panelInfo : null
      const openSession = makeOpenSession(ctx, t)

      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: function () {
            const face = { t: t, openSession: openSession }
            if (panelInfo) face.hooks = { panelInfo: panelInfo }
            return face
          },
        }, BotsPage)
      })

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          locale: NS,
          label: function () { return t('panel') },
        }, BotsGlyph)
      })
    }

    return { inject: inject, apply: apply }
  },
})
