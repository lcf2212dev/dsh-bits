/**
 * Bots — browser half of the `@local/dsh-bots` bundle.
 *
 * Contributes a "Bots" entry to the sidebar's global panel list and a full page
 * in the layout's `main` keyed slot. The page lists the bots the Host exposes on
 * `/api/bots.*`, lets the user chat with one (navigating through
 * `ctx.uiWorkspace.startSession(workspaceId)`), create/edit/delete bots and
 * drive each bot's optional Docker VM (start/stop/restart/remove).
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
  id: '@local/dsh-bots',
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
    /** Poll period while the panel is visible. */
    const POLL_MS = 5000
    /** Image the Host store falls back to. */
    const DEFAULT_IMAGE = 'ubuntu:24.04'
    /** Field limits mirroring the record contract (CONTRACT.md §2). */
    const MAX_NAME = 60
    const MAX_EMOJI = 8
    const MAX_INSTRUCTIONS = 20000
    /** Docker image reference validation, mirroring the Host. */
    const IMAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/
    /** Hex colour palette offered by the form; the Host picks from its own fixed palette. */
    const COLOR_PALETTE = [
      '#7c3aed', '#2563eb', '#0891b2', '#059669', '#65a30d',
      '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#475569',
    ]
    /** Emoji presets offered by the form (1..8 characters each). */
    const EMOJI_PALETTE = [
      '🤖', '🧠', '🦉', '🧑‍💻', '🦊', '🐙', '🚀', '🎯', '🧪', '📚', '🎨', '🛠️',
    ]

    /* ------------------------------------------------------------------ */
    /* Locale dictionaries                                                */
    /* ------------------------------------------------------------------ */

    /** Brazilian Portuguese — primary copy for this deployment. */
    const PT = {
      panel: 'Bots',
      title: 'Bots',
      subtitle: 'Equipes de IA com persona própria, workspace dedicado e, opcionalmente, uma máquina virtual Docker.',
      newBot: 'Novo bot',
      editBot: 'Editar bot',
      create: 'Criar bot',
      chat: 'Conversar',
      edit: 'Editar',
      delete: 'Excluir bot',
      deleteTitle: 'Excluir {name}?',
      deleteBody: 'O bot será removido da lista. O workspace e os arquivos dele são mantidos, a menos que você marque a opção abaixo.',
      deleteFiles: 'Também apagar os arquivos do workspace',
      deleteConfirm: 'Excluir bot',
      cancel: 'Cancelar',
      save: 'Salvar',
      saving: 'Salvando…',
      name: 'Nome',
      namePlaceholder: 'Ex.: Pesquisador',
      nameRequired: 'Informe um nome para o bot.',
      nameTooLong: 'O nome deve ter no máximo 60 caracteres.',
      emoji: 'Emoji',
      emojiHint: 'Escolha um emoji abaixo ou digite até 8 caracteres.',
      emojiTooLong: 'O emoji deve ter no máximo 8 caracteres.',
      color: 'Cor',
      instructions: 'Instruções',
      instructionsHint: 'Persona e instruções enviadas ao bot em todas as conversas (até 20.000 caracteres).',
      instructionsPlaceholder: 'Você é o Pesquisador…',
      instructionsTooLong: 'As instruções devem ter no máximo 20.000 caracteres.',
      noInstructions: 'Sem instruções ainda.',
      vm: 'Máquina virtual',
      vmEnable: 'Executar comandos em uma VM Docker',
      vmEnableHint: 'Quando ativada, os comandos de shell do bot rodam dentro de um container persistente.',
      vmImage: 'Imagem Docker',
      vmImageLocal: 'Imagens locais',
      vmImageFree: 'Referência da imagem',
      vmImagePlaceholder: 'ubuntu:24.04',
      vmImageHint: 'Escolha uma imagem local ou digite qualquer referência (ex.: ubuntu:24.04). A imagem precisa existir no Docker local.',
      imagesLoading: 'Carregando imagens…',
      imagesEmpty: 'Nenhuma imagem local encontrada.',
      imagesError: 'Não foi possível listar as imagens do Docker.',
      imageInvalid: 'Referência de imagem inválida.',
      vmRunning: 'Rodando',
      vmStopped: 'Desligada',
      vmCreated: 'Criada',
      vmPaused: 'Pausada',
      vmMissing: 'VM não iniciada',
      vmNoVm: 'Sem VM',
      vmError: 'Falha na VM',
      vmImageMissing: 'Imagem ausente',
      vmImageMissingHint: 'A imagem {image} não existe localmente. Baixe-a com: docker pull {image}',
      vmStart: 'Iniciar VM',
      vmStop: 'Parar VM',
      vmRestart: 'Reiniciar VM',
      vmRemove: 'Remover VM',
      vmActions: 'Ações da VM',
      vmRemoveTitle: 'Remover a VM de {name}?',
      vmRemoveBody: 'O container será removido. Os arquivos do workspace e o cadastro do bot serão mantidos.',
      vmStarted: 'VM iniciada.',
      vmStoppedMsg: 'VM parada.',
      vmRestarted: 'VM reiniciada.',
      vmRemoved: 'VM removida.',
      notifyTest: 'Testar notificação no computador',
      notifyTestBody: 'Notificações funcionando: vou te avisar por aqui quando você pedir um lembrete.',
      notifyTestSent: 'Notificação enviada. Ela deve aparecer no canto da sua tela.',
      notifyTestFailed: 'Não foi possível mostrar a notificação',
      dockerReady: 'Docker pronto',
      dockerUnavailable: 'Docker indisponível',
      dockerUnknown: 'Docker desconhecido',
      workspace: 'Workspace',
      workspaceUnavailable: 'Workspace ainda indisponível.',
      chatUnavailable: 'O workspace deste bot ainda não está disponível. Atualize a lista e tente novamente.',
      loading: 'Carregando bots…',
      empty: 'Nenhum bot ainda',
      emptyHint: 'Crie um bot para conversar com uma IA que tem persona, workspace e, se quiser, uma VM próprios.',
      error: 'Não foi possível carregar os bots.',
      retry: 'Tentar novamente',
      confirm: 'Confirmar',
      deleted: 'Bot excluído.',
      deletedWorkspace: 'Bot excluído e workspace apagado.',
      saved: 'Alterações salvas.',
      created: 'Bot criado.',
      failed: 'Falhou',
      refresh: 'Atualizar',
      refreshing: 'Atualizando…',
      working: 'Processando…',
      close: 'Fechar',
    }

    /** English — complete fallback dictionary (same keys as PT). */
    const EN = {
      panel: 'Bots',
      title: 'Bots',
      subtitle: 'AI teammates with their own persona, workspace and, optionally, a Docker virtual machine.',
      newBot: 'New bot',
      editBot: 'Edit bot',
      create: 'Create bot',
      chat: 'Chat',
      edit: 'Edit',
      delete: 'Delete bot',
      deleteTitle: 'Delete {name}?',
      deleteBody: 'The bot will be removed from the list. Its workspace and files are kept unless you check the option below.',
      deleteFiles: 'Also delete the workspace files',
      deleteConfirm: 'Delete bot',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      name: 'Name',
      namePlaceholder: 'E.g. Researcher',
      nameRequired: 'Enter a name for the bot.',
      nameTooLong: 'The name must be at most 60 characters.',
      emoji: 'Emoji',
      emojiHint: 'Pick an emoji below or type up to 8 characters.',
      emojiTooLong: 'The emoji must be at most 8 characters.',
      color: 'Color',
      instructions: 'Instructions',
      instructionsHint: 'Persona and instructions sent to the bot in every conversation (up to 20,000 characters).',
      instructionsPlaceholder: 'You are the Researcher…',
      instructionsTooLong: 'Instructions must be at most 20,000 characters.',
      noInstructions: 'No instructions yet.',
      vm: 'Virtual machine',
      vmEnable: 'Run commands in a Docker VM',
      vmEnableHint: 'When enabled, the bot shell commands run inside a persistent container.',
      vmImage: 'Docker image',
      vmImageLocal: 'Local images',
      vmImageFree: 'Image reference',
      vmImagePlaceholder: 'ubuntu:24.04',
      vmImageHint: 'Pick a local image or type any reference (e.g. ubuntu:24.04). The image must exist in the local Docker.',
      imagesLoading: 'Loading images…',
      imagesEmpty: 'No local images found.',
      imagesError: 'Could not list Docker images.',
      imageInvalid: 'Invalid image reference.',
      vmRunning: 'Running',
      vmStopped: 'Stopped',
      vmCreated: 'Created',
      vmPaused: 'Paused',
      vmMissing: 'VM not started',
      vmNoVm: 'No VM',
      vmError: 'VM failure',
      vmImageMissing: 'Image missing',
      vmImageMissingHint: 'Image {image} is not available locally. Download it with: docker pull {image}',
      vmStart: 'Start VM',
      vmStop: 'Stop VM',
      vmRestart: 'Restart VM',
      vmRemove: 'Remove VM',
      vmActions: 'VM actions',
      vmRemoveTitle: 'Remove the VM of {name}?',
      vmRemoveBody: 'The container will be removed. The workspace files and the bot record are kept.',
      vmStarted: 'VM started.',
      vmStoppedMsg: 'VM stopped.',
      vmRestarted: 'VM restarted.',
      vmRemoved: 'VM removed.',
      notifyTest: 'Send a test desktop notification',
      notifyTestBody: 'Notifications work: I will alert you here when you ask for a reminder.',
      notifyTestSent: 'Notification sent. It should appear on your screen.',
      notifyTestFailed: 'Could not show the notification',
      dockerReady: 'Docker ready',
      dockerUnavailable: 'Docker unavailable',
      dockerUnknown: 'Docker unknown',
      workspace: 'Workspace',
      workspaceUnavailable: 'Workspace not ready yet.',
      chatUnavailable: 'This bot workspace is not available yet. Refresh the list and try again.',
      loading: 'Loading bots…',
      empty: 'No bots yet',
      emptyHint: 'Create a bot to chat with an AI that has its own persona, workspace and, if you want, a VM.',
      error: 'Could not load the bots.',
      retry: 'Retry',
      confirm: 'Confirm',
      deleted: 'Bot deleted.',
      deletedWorkspace: 'Bot deleted and workspace removed.',
      saved: 'Changes saved.',
      created: 'Bot created.',
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
.dsh-bots-pill { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 28px; padding: 0 10px; border: 1px solid var(--dsh-bots-border-2); border-radius: 999px; background: var(--dsh-bots-bg-1); color: var(--dsh-bots-text-2); font-size: 12px; line-height: 18px; white-space: nowrap; }
.dsh-bots-pill-ok { color: var(--dsh-bots-ok); }
.dsh-bots-pill-bad { color: var(--dsh-bots-bad); }
.dsh-bots-pill-detail { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
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
.dsh-bots-vm-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
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
.dsh-bots-vm-box { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsh-bots-border-2); border-radius: var(--dsh-bots-radius-md); background: var(--dsh-bots-bg-1); }
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
    const ChatIcon = pathsIcon([
      'M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 12H7l-3 2.6V12H4a1.5 1.5 0 0 1-1.5-1.5z',
    ])
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
    const BellIcon = pathsIcon([
      'M4 11.5V7.2a4 4 0 0 1 8 0v4.3l1 1H3z',
      'M6.6 13.6a1.5 1.5 0 0 0 2.8 0',
    ])
    const StopIcon = h('rect', { x: 4.5, y: 4.5, width: 7, height: 7, rx: 1 })
    const StopIconComponent = (function () {
      return function Icon(props) {
        const size = props && typeof props.size === 'number' ? props.size : 16
        return h('svg', {
          width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true',
          focusable: 'false', style: { display: 'block', flex: 'none' },
        }, StopIcon)
      }
    })()
    const RestartIcon = RefreshIcon
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

    /** Count Unicode code points the way the Host store validates emoji (not UTF-16 units). */
    function codePointLength(value) {
      return Array.from(asString(value)).length
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

    /** Defensive VM status projection: a host bug must never blank the page. */
    function normalizeVmStatus(raw) {
      const source = isObject(raw) ? raw : {}
      return {
        state: asString(source.state) || 'missing',
        running: source.running === true,
        image: asString(source.image),
        containerName: asString(source.containerName),
        detail: asString(source.detail),
        error: asString(source.error),
        startedAt: asString(source.startedAt),
        exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
      }
    }

    /** Defensive BotView projection (CONTRACT.md §2). */
    function normalizeBot(raw) {
      if (!isObject(raw)) return null
      const id = asString(raw.id)
      if (!id) return null
      const vm = isObject(raw.vm) ? raw.vm : {}
      return {
        id: id,
        name: asString(raw.name) || id,
        emoji: asString(raw.emoji) || '🤖',
        color: /^#[0-9a-fA-F]{6}$/.test(asString(raw.color)) ? asString(raw.color) : COLOR_PALETTE[0],
        instructions: asString(raw.instructions),
        workspaceDir: asString(raw.workspaceDir),
        workspaceId: asString(raw.workspaceId) || null,
        workspaceError: asString(raw.workspaceError) || null,
        vm: { enabled: vm.enabled === true, image: asString(vm.image) },
        vmStatus: normalizeVmStatus(raw.vmStatus),
        createdAt: asString(raw.createdAt),
        updatedAt: asString(raw.updatedAt),
      }
    }

    /** Defensive Docker availability projection. */
    function normalizeDocker(raw) {
      if (!isObject(raw)) return { available: false, version: null, error: null }
      return {
        available: raw.available === true,
        version: asString(raw.version) || null,
        error: asString(raw.error) || null,
      }
    }

    /** Normalize `/api/bots.list`. */
    function normalizeListPayload(payload) {
      const bots = []
      if (Array.isArray(payload.bots)) {
        payload.bots.forEach(function (raw) {
          const bot = normalizeBot(raw)
          if (bot) bots.push(bot)
        })
      }
      return {
        bots: bots,
        docker: normalizeDocker(payload.docker),
        defaultImage: asString(payload.defaultImage) || DEFAULT_IMAGE,
      }
    }

    /** Normalize `/api/bots.images`; tolerates `{ name, tag }` entries. */
    function normalizeImagesPayload(payload) {
      const images = []
      if (Array.isArray(payload.images)) {
        payload.images.forEach(function (raw) {
          if (!isObject(raw)) return
          const reference = asString(raw.reference) || (asString(raw.name)
            ? asString(raw.name) + (asString(raw.tag) ? ':' + asString(raw.tag) : '')
            : '')
          if (!reference) return
          images.push({ reference: reference })
        })
      }
      return {
        images: images,
        defaultImage: asString(payload.defaultImage) || DEFAULT_IMAGE,
      }
    }

    /** Normalize `/api/bots.vm` (and create/update payloads). */
    function normalizeBotPayload(payload) {
      const bot = normalizeBot(payload.bot)
      if (!bot) throw apiError('BAD_RESPONSE', 'The server response is missing the bot record')
      return bot
    }

    const api = {
      async list() {
        return normalizeListPayload(await fetchJson('/api/bots.list'))
      },
      async images() {
        return normalizeImagesPayload(await fetchJson('/api/bots.images'))
      },
      async create(fields) {
        return normalizeBotPayload(await fetchJson('/api/bots.create', fields))
      },
      async update(id, patch) {
        return normalizeBotPayload(await fetchJson('/api/bots.update', { id: id, patch: patch }))
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
      async vm(id, action) {
        return normalizeBotPayload(await fetchJson('/api/bots.vm', { id: id, action: action }))
      },
      async notifyTest(id, message) {
        await fetchJson('/api/bots.notify-test', { id: id, message: message })
      },
    }

    /* ------------------------------------------------------------------ */
    /* Form helpers                                                       */
    /* ------------------------------------------------------------------ */

    /** Default form values for create/edit. */
    function initialFormValues(bot, defaultImage) {
      const fallbackImage = asString(defaultImage) || DEFAULT_IMAGE
      if (bot) {
        return {
          name: bot.name,
          emoji: bot.emoji,
          color: bot.color,
          instructions: bot.instructions,
          vmEnabled: bot.vm.enabled === true,
          vmImage: bot.vm.image || fallbackImage,
        }
      }
      return {
        name: '',
        emoji: EMOJI_PALETTE[0],
        color: COLOR_PALETTE[0],
        instructions: '',
        vmEnabled: false,
        vmImage: fallbackImage,
      }
    }

    /** Client-side validation mirroring the record rules; returns `{ field: messageKey }`. */
    function validateForm(values, t) {
      const errors = {}
      const name = asString(values.name).trim()
      if (!name) errors.name = t('nameRequired')
      else if (name.length > MAX_NAME) errors.name = t('nameTooLong')
      if (codePointLength(asString(values.emoji).trim()) > MAX_EMOJI) errors.emoji = t('emojiTooLong')
      if (asString(values.instructions).length > MAX_INSTRUCTIONS) errors.instructions = t('instructionsTooLong')
      if (values.vmEnabled === true) {
        const image = asString(values.vmImage).trim()
        if (!IMAGE_PATTERN.test(image)) errors.vmImage = t('imageInvalid')
      }
      return errors
    }

    function hasKeys(object) {
      return Object.keys(object).length > 0
    }

    /** Payload shared by create and update for the editable fields. */
    function formPayload(values) {
      return {
        name: asString(values.name).trim(),
        // The record contract requires 1..8 characters; empty falls back to the default.
        emoji: asString(values.emoji).trim() || '🤖',
        color: asString(values.color),
        instructions: asString(values.instructions),
        vm: {
          enabled: values.vmEnabled === true,
          // The Host validates vm.image on every write; fall back when it is empty/invalid.
          image: IMAGE_PATTERN.test(asString(values.vmImage).trim())
            ? asString(values.vmImage).trim()
            : DEFAULT_IMAGE,
        },
      }
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

    /** VM state / Docker pill. */
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
          className: 'dsh-bots-dialog' + (props.wide ? ' dsh-bots-dialog-wide' : ''),
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

    /** Docker availability pill for the page header. */
    function DockerPill(props) {
      const t = props.t
      const docker = isObject(props.docker) ? props.docker : null
      if (!docker) {
        return h('span', { className: 'dsh-bots-pill', role: 'status' },
          h('span', { className: 'dsh-bots-dot', 'aria-hidden': 'true' }),
          t('dockerUnknown'))
      }
      const available = docker.available === true
      const version = asString(docker.version)
      const error = asString(docker.error)
      const label = available ? (version ? 'Docker ' + version : t('dockerReady')) : t('dockerUnavailable')
      return h('span', {
        className: 'dsh-bots-pill' + (available ? ' dsh-bots-pill-ok' : ' dsh-bots-pill-bad'),
        role: 'status',
        title: available ? t('dockerReady') + (version ? ' (' + version + ')' : '') : t('dockerUnavailable') + (error ? ': ' + error : ''),
      },
        h('span', { className: 'dsh-bots-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dsh-bots-pill-detail' }, label)
      )
    }

    /* ------------------------------------------------------------------ */
    /* VM presentation                                                    */
    /* ------------------------------------------------------------------ */

    /** Whether the VM has a container Docker can start/stop/remove. */
    function hasVmContainer(state) {
      return ['running', 'created', 'exited', 'stopped', 'paused'].indexOf(state) >= 0
    }

    /** Canonical Docker reference: implicit `:latest`, no default registry prefix. */
    function canonicalImage(reference) {
      let value = asString(reference).trim()
      if (!value) return ''
      value = value.replace(/^docker\.io\//, '').replace(/^library\//, '')
      if (value.indexOf('@') >= 0) return value
      const lastSlash = value.lastIndexOf('/')
      return value.indexOf(':', lastSlash + 1) >= 0 ? value : value + ':latest'
    }

    /** Whether a bot's VM image is known to be absent locally (null = unknown). */
    function imageMissing(bot, localImages) {
      if (!localImages || bot.vm.enabled !== true) return false
      const wanted = canonicalImage(bot.vm.image)
      return wanted !== '' && !localImages.has(wanted)
    }

    /** Keep the meaningful tail of a long path (`…/bots/<id>/workspace`). */
    function shortPath(value) {
      const text = asString(value)
      const marker = text.lastIndexOf('/bots/')
      if (marker > 0) return '…' + text.slice(marker)
      const parts = text.split('/').filter(Boolean)
      return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : text
    }

    /** Badge model for one bot's VM state. */
    function vmBadge(bot, docker, t, localImages) {
      if (bot.vm.enabled !== true) {
        return { label: t('vmNoVm'), tone: 'neutral' }
      }
      const status = bot.vmStatus || {}
      const state = asString(status.state) || 'missing'
      const dockerKnown = isObject(docker) && docker.available === false
      if (dockerKnown) {
        return { label: t('dockerUnavailable'), tone: 'bad', title: asString(docker.error) || undefined }
      }
      if (state === 'running') return { label: t('vmRunning'), tone: 'ok', title: status.containerName || undefined }
      if (state === 'created') return { label: t('vmCreated'), tone: 'warn' }
      if (state === 'paused') return { label: t('vmPaused'), tone: 'warn' }
      if (state === 'missing' && imageMissing(bot, localImages)) {
        return { label: t('vmImageMissing'), tone: 'warn', title: t('vmImageMissingHint').replace('{image}', bot.vm.image) }
      }
      if (state === 'missing') return { label: t('vmMissing'), tone: 'neutral', title: bot.vm.image || undefined }
      if (state === 'unavailable') {
        return { label: t('dockerUnavailable'), tone: 'bad', title: status.error || undefined }
      }
      if (state === 'error') {
        const detail = asString(status.error) + ' ' + asString(status.detail)
        if (/image|imagem/i.test(detail)) {
          return { label: t('vmImageMissing'), tone: 'bad', title: detail.trim() || undefined }
        }
        return { label: t('vmError'), tone: 'bad', title: detail.trim() || undefined }
      }
      return { label: t('vmStopped'), tone: 'neutral', title: status.detail || undefined }
    }

    /** One VM lifecycle button descriptor list for a bot card. */
    function vmActionsFor(bot, docker, t) {
      const actions = []
      if (bot.vm.enabled !== true) return actions
      const state = asString((bot.vmStatus || {}).state) || 'missing'
      const dockerReady = !(isObject(docker) && docker.available === false)
      if (state === 'running') {
        actions.push({ action: 'stop', label: t('vmStop'), icon: h(StopIconComponent, { size: 14 }) })
        actions.push({ action: 'restart', label: t('vmRestart'), icon: h(RestartIcon, { size: 14 }) })
      } else {
        actions.push({ action: 'start', label: t('vmStart'), icon: h(PlayIcon, { size: 14 }) })
      }
      if (hasVmContainer(state)) {
        actions.push({ action: 'remove', label: t('vmRemove'), icon: h(TrashIcon, { size: 14 }), danger: true })
      }
      return actions.map(function (item) {
        item.disabled = !dockerReady
        return item
      })
    }

    /* ------------------------------------------------------------------ */
    /* Bot card                                                           */
    /* ------------------------------------------------------------------ */

    function BotCard(props) {
      const t = props.t
      const bot = props.bot
      const docker = props.docker
      const busy = props.busy
      const botBusy = busy !== null && busy.botId === bot.id
      const vmBusy = botBusy && busy.kind === 'vm'
      const dockerReady = !(isObject(docker) && docker.available === false)
      const badge = vmBadge(bot, docker, t, props.localImages)
      const persona = excerpt(bot.instructions, 240)
      const canChat = !!bot.workspaceId
      const chatTitle = canChat ? undefined : t('chatUnavailable')
      const vmActions = vmActionsFor(bot, docker, t)

      const chatButton = h(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: !canChat || botBusy,
        title: chatTitle,
        onClick: function () { props.onChat(bot) },
      }, h(ChatIcon, { size: 14 }), t('chat'))

      const editButton = h(Button, {
        variant: 'outline',
        size: 'sm',
        disabled: botBusy,
        onClick: function () { props.onEdit(bot) },
      }, h(EditIcon, { size: 14 }), t('edit'))

      const notifyButton = h(IconButton, {
        label: t('notifyTest'),
        className: 'dsh-bots-icon-button-sm',
        disabled: botBusy,
        onClick: function () { props.onNotifyTest(bot) },
      }, h(BellIcon, { size: 14 }))

      const vmButtons = vmActions.map(function (item) {
        const title = item.disabled ? t('dockerUnavailable') : item.label
        return h(Button, {
          key: 'vm-' + item.action,
          variant: 'ghost',
          size: 'sm',
          disabled: item.disabled || botBusy,
          busy: vmBusy && busy.action === item.action,
          title: title,
          onClick: function () { props.onVmAction(bot, item.action) },
        }, item.icon, item.action === 'remove' ? t('vmRemove') : item.label)
      })

      const deleteButton = h(Button, {
        variant: 'ghost',
        size: 'sm',
        className: 'dsh-bots-button-danger',
        disabled: botBusy,
        onClick: function () { props.onDelete(bot) },
      }, h(TrashIcon, { size: 14 }), t('delete'))

      const workspaceValue = bot.workspaceDir || bot.workspaceId || '—'
      const workspaceShort = shortPath(workspaceValue)

      return h('li', { className: 'dsh-bots-card' },
        h('div', { className: 'dsh-bots-card-head' },
          h('span', {
            className: 'dsh-bots-avatar',
            'aria-hidden': 'true',
            style: { backgroundColor: bot.color, color: contrastText(bot.color) },
          }, bot.emoji),
          h('div', { className: 'dsh-bots-card-titles' },
            h('div', { className: 'dsh-bots-name-row' },
              h('h3', { className: 'dsh-bots-name', title: bot.name }, bot.name),
              h(Badge, { label: badge.label, tone: badge.tone, title: badge.title })
            ),
            h('div', { className: 'dsh-bots-meta' },
              h('span', { className: 'dsh-bots-meta-label' }, t('workspace')),
              h('span', { className: 'dsh-bots-path', title: workspaceValue }, workspaceShort)
            )
          )
        ),
        h('p', {
          className: 'dsh-bots-persona' + (persona ? '' : ' dsh-bots-persona-empty'),
          title: persona || undefined,
        }, persona || t('noInstructions')),
        bot.workspaceError ? h('p', { className: 'dsh-bots-warn' }, bot.workspaceError) : null,
        bot.vm.enabled === true && bot.vm.image && !hasVmContainer(asString(bot.vmStatus.state))
          ? h('div', { className: 'dsh-bots-meta' },
            h('span', { className: 'dsh-bots-meta-label' }, t('vmImage')),
            h('span', { className: 'dsh-bots-path', title: bot.vm.image }, bot.vm.image))
          : null,
        h('div', { className: 'dsh-bots-actions' },
          chatButton,
          editButton,
          notifyButton,
          vmButtons.length > 0 ? h('span', { className: 'dsh-bots-actions-grow' }) : null,
          vmButtons.length > 0
            ? h('span', { className: 'dsh-bots-vm-actions', role: 'group', 'aria-label': t('vmActions') }, vmButtons)
            : null,
          deleteButton
        )
      )
    }

    /* ------------------------------------------------------------------ */
    /* Create / edit dialog                                               */
    /* ------------------------------------------------------------------ */

    function FormDialog(props) {
      const t = props.t
      const editing = !!props.bot
      const onCancel = props.onCancel
      const onSubmit = props.onSubmit
      const nameRef = React.useRef(null)
      const imageRequestedRef = React.useRef(false)
      const [values, setValues] = React.useState(function () {
        return initialFormValues(props.bot, props.defaultImage)
      })
      const [errors, setErrors] = React.useState({})
      const [serverError, setServerError] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [imageState, setImageState] = React.useState(function () {
        return { phase: 'idle', images: [], defaultImage: props.defaultImage || DEFAULT_IMAGE, error: null }
      })

      React.useEffect(function () {
        if (values.vmEnabled !== true || imageRequestedRef.current) return
        imageRequestedRef.current = true
        setImageState(function (previous) {
          return { phase: 'loading', images: previous.images, defaultImage: previous.defaultImage, error: null }
        })
        api.images().then(function (data) {
          setImageState({ phase: 'ready', images: data.images, defaultImage: data.defaultImage, error: null })
        }).catch(function (error) {
          setImageState(function (previous) {
            return { phase: 'error', images: previous.images, defaultImage: previous.defaultImage, error: describeError(error) }
          })
        })
      }, [values.vmEnabled])

      function patchValues(patch) {
        setValues(function (previous) {
          const next = {}
          Object.keys(previous).forEach(function (key) { next[key] = previous[key] })
          Object.keys(patch).forEach(function (key) { next[key] = patch[key] })
          return next
        })
      }

      function requestClose() {
        if (saving) return
        if (typeof onCancel === 'function') onCancel()
      }

      function submit(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (saving) return
        const nextErrors = validateForm(values, t)
        setErrors(nextErrors)
        if (hasKeys(nextErrors)) {
          if (nameRef.current && typeof nameRef.current.focus === 'function') nameRef.current.focus()
          return
        }
        setSaving(true)
        setServerError(null)
        let result
        try {
          result = onSubmit(formPayload(values))
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

      function toggleEmoji(emoji) {
        patchValues({ emoji: emoji })
      }

      function toggleColor(color) {
        patchValues({ color: color })
      }

      const emojiPalette = EMOJI_PALETTE.map(function (emoji) {
        return h('button', {
          key: 'emoji-' + emoji,
          type: 'button',
          className: 'dsh-bots-emoji-chip',
          'aria-pressed': values.emoji === emoji ? 'true' : 'false',
          'aria-label': emoji,
          disabled: saving,
          onClick: function () { toggleEmoji(emoji) },
        }, emoji)
      })

      const colorPalette = COLOR_PALETTE.slice()
      if (colorPalette.indexOf(values.color) < 0) colorPalette.push(values.color)
      const swatches = colorPalette.map(function (color) {
        return h('button', {
          key: 'color-' + color,
          type: 'button',
          className: 'dsh-bots-swatch',
          style: { backgroundColor: color },
          'aria-pressed': values.color === color ? 'true' : 'false',
          'aria-label': color,
          title: color,
          disabled: saving,
          onClick: function () { toggleColor(color) },
        })
      })

      const imageOptions = []
      const seenImages = {}
      function pushImage(reference) {
        if (!reference || seenImages[reference]) return
        seenImages[reference] = true
        imageOptions.push(reference)
      }
      pushImage(values.vmImage)
      pushImage(imageState.defaultImage)
      imageState.images.forEach(function (image) { pushImage(image.reference) })

      let imageHint = t('vmImageHint')
      if (imageState.phase === 'loading') imageHint = t('imagesLoading')
      else if (imageState.phase === 'error') imageHint = t('imagesError')
      else if (imageState.phase === 'ready' && imageState.images.length === 0) imageHint = t('imagesEmpty')

      const imageField = values.vmEnabled === true
        ? h(Field, {
          label: t('vmImage'),
          error: errors.vmImage,
          hint: imageHint,
        },
          h('label', { className: 'dsh-bots-hint', htmlFor: 'dsh-bots-image-select' }, t('vmImageLocal')),
          h('select', {
            id: 'dsh-bots-image-select',
            className: 'dsh-bots-select',
            value: values.vmImage,
            'aria-invalid': errors.vmImage ? 'true' : 'false',
            disabled: saving,
            onChange: function (event) { patchValues({ vmImage: event.target.value }) },
          }, imageOptions.map(function (image) {
            return h('option', { key: 'image-' + image, value: image }, image)
          })),
          h('label', { className: 'dsh-bots-hint', htmlFor: 'dsh-bots-image-input' }, t('vmImageFree')),
          h('input', {
            id: 'dsh-bots-image-input',
            className: 'dsh-bots-input',
            type: 'text',
            spellCheck: false,
            autoComplete: 'off',
            placeholder: t('vmImagePlaceholder'),
            value: values.vmImage,
            'aria-invalid': errors.vmImage ? 'true' : 'false',
            disabled: saving,
            onChange: function (event) { patchValues({ vmImage: event.target.value }) },
          })
        )
        : null

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

      return h(Modal, {
        t: t,
        title: editing ? t('editBot') : t('newBot'),
        wide: true,
        initialFocusRef: nameRef,
        onClose: requestClose,
        dismissDisabled: saving,
        footer: footer,
      },
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
            placeholder: t('namePlaceholder'),
            value: values.name,
            'aria-invalid': errors.name ? 'true' : 'false',
            disabled: saving,
            onChange: function (event) { patchValues({ name: event.target.value }) },
          })
        ),
        h(Field, {
          label: t('emoji'),
          hint: t('emojiHint'),
          error: errors.emoji,
        },
          h('input', {
            className: 'dsh-bots-input',
            type: 'text',
            autoComplete: 'off',
            maxLength: MAX_EMOJI * 2,
            value: values.emoji,
            'aria-invalid': errors.emoji ? 'true' : 'false',
            'aria-label': t('emoji'),
            disabled: saving,
            onChange: function (event) { patchValues({ emoji: event.target.value }) },
          }),
          h('div', { className: 'dsh-bots-palette', role: 'group', 'aria-label': t('emoji') }, emojiPalette)
        ),
        h(Field, {
          label: t('color'),
        },
          h('div', { className: 'dsh-bots-palette', role: 'group', 'aria-label': t('color') }, swatches)
        ),
        h(Field, {
          label: t('instructions'),
          error: errors.instructions,
        },
          h('textarea', {
            className: 'dsh-bots-textarea',
            rows: 8,
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
          )
        ),
        h('div', { className: 'dsh-bots-vm-box' },
          h('div', { className: 'dsh-bots-label' }, t('vm')),
          h(Switch, {
            checked: values.vmEnabled === true,
            label: t('vmEnable'),
            disabled: saving,
            onChange: function (checked) { patchValues({ vmEnabled: checked }) },
          }),
          h('p', { className: 'dsh-bots-hint' }, t('vmEnableHint')),
          imageField
        ),
        serverError ? h('p', { className: 'dsh-bots-error dsh-bots-form-error', role: 'alert' }, serverError) : null
      )
    }

    /* ------------------------------------------------------------------ */
    /* Confirm dialog (delete bot / remove VM)                            */
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

    /* ------------------------------------------------------------------ */
    /* Page                                                               */
    /* ------------------------------------------------------------------ */

    function BotsPage(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT
      const startSession = typeof props.startSession === 'function' ? props.startSession : null
      const usePanelInfo = typeof props.usePanelInfo === 'function' ? props.usePanelInfo : useAlwaysActivePanelInfo
      const panelActive = usePanelInfo(selectPanelActive)

      const [data, setData] = React.useState(function () {
        return { phase: 'loading', bots: [], docker: null, defaultImage: DEFAULT_IMAGE, error: null }
      })
      const [dialog, setDialog] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      const [refreshing, setRefreshing] = React.useState(false)
      const [localImages, setLocalImages] = React.useState(null)
      const imagesLoadedRef = React.useRef(false)

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

      const load = React.useCallback(async function (quiet) {
        if (inFlightRef.current) return
        inFlightRef.current = true
        if (quiet !== true) {
          setData(function (previous) {
            return {
              phase: previous.bots.length > 0 ? 'ready' : 'loading',
              bots: previous.bots,
              docker: previous.docker,
              defaultImage: previous.defaultImage,
              error: null,
            }
          })
        }
        try {
          const payload = await api.list()
          if (!aliveRef.current) return
          loadedRef.current = true
          // Local images change rarely: probe them on explicit loads only, not on every poll.
          if ((quiet !== true || !imagesLoadedRef.current) && payload.bots.some(function (bot) { return bot.vm.enabled === true })) {
            imagesLoadedRef.current = true
            api.images().then(function (images) {
              if (!aliveRef.current) return
              setLocalImages(new Set(images.images.map(function (image) { return canonicalImage(image.reference) })))
            }, function () {
              if (aliveRef.current) setLocalImages(null)
            })
          }
          setData({
            phase: 'ready',
            bots: payload.bots,
            docker: payload.docker,
            defaultImage: payload.defaultImage,
            error: null,
          })
        } catch (error) {
          if (!aliveRef.current) return
          if (quiet !== true) {
            setData(function (previous) {
              return {
                phase: previous.bots.length > 0 ? 'ready' : 'error',
                bots: previous.bots,
                docker: previous.docker,
                defaultImage: previous.defaultImage,
                error: describeError(error),
              }
            })
          } else {
            console.warn('[bots] background refresh failed:', describeError(error))
          }
        } finally {
          inFlightRef.current = false
        }
      }, [])

      React.useEffect(function () {
        if (!panelActive) return undefined
        load(loadedRef.current)
        const timer = setInterval(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load(true)
        }, POLL_MS)
        return function () { clearInterval(timer) }
      }, [panelActive, load])

      function openCreate() {
        setDialog({ kind: 'form', bot: null })
      }

      function openEdit(bot) {
        setDialog({ kind: 'form', bot: bot })
      }

      function openDelete(bot) {
        setDialog({ kind: 'delete', bot: bot })
      }

      function openVmRemove(bot) {
        setDialog({ kind: 'removeVm', bot: bot })
      }

      function closeDialog() {
        setDialog(null)
      }

      function handleChat(bot) {
        if (!bot.workspaceId) return
        try {
          if (!startSession) throw new Error(t('chatUnavailable'))
          startSession(bot.workspaceId)
        } catch (error) {
          showToast('error', t('chatUnavailable') + ' ' + describeError(error))
        }
      }

      async function saveBot(values) {
        const fields = formPayload(values)
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

      async function confirmVmRemove() {
        if (!dialog || !dialog.bot) return
        await api.vm(dialog.bot.id, 'remove')
        setDialog(null)
        showToast('success', t('vmRemoved'))
        await load(true)
      }

      async function runNotifyTest(bot) {
        if (busy) return
        setBusy({ kind: 'notify', botId: bot.id, action: 'notify' })
        try {
          await api.notifyTest(bot.id, t('notifyTestBody'))
          showToast('success', t('notifyTestSent'))
        } catch (error) {
          showToast('error', t('notifyTestFailed') + ': ' + describeError(error))
        } finally {
          setBusy(null)
        }
      }

      async function runVmAction(bot, action) {
        if (action === 'remove') {
          openVmRemove(bot)
          return
        }
        if (busy) return
        const labels = { start: 'vmStarted', stop: 'vmStoppedMsg', restart: 'vmRestarted' }
        setBusy({ kind: 'vm', botId: bot.id, action: action })
        try {
          await api.vm(bot.id, action)
          showToast('success', t(labels[action] || 'saved'))
        } catch (error) {
          showToast('error', t('failed') + ': ' + describeError(error))
        } finally {
          setBusy(null)
          await load(true)
        }
      }

      async function handleRefresh() {
        if (refreshing) return
        setRefreshing(true)
        try {
          await load(false)
        } finally {
          setRefreshing(false)
        }
      }

      const bots = data.bots
      const phase = data.phase
      const toolbar = h('div', { className: 'dsh-bots-toolbar' },
        h(DockerPill, { docker: data.docker, t: t }),
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
      } else if (phase === 'error' && bots.length === 0) {
        body = h('div', { className: 'dsh-bots-state dsh-bots-state-error' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(WarningIcon, { size: 28 })),
          h('p', { className: 'dsh-bots-state-title' }, t('error')),
          data.error ? h('p', { className: 'dsh-bots-state-text' }, data.error) : null,
          h(Button, { variant: 'outline', onClick: handleRefresh }, t('retry'))
        )
      } else if (bots.length === 0) {
        body = h('div', { className: 'dsh-bots-state' },
          h('span', { className: 'dsh-bots-state-icon', 'aria-hidden': 'true' }, h(BotsGlyph, { size: 40 })),
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
            bots.map(function (bot) {
              return h(BotCard, {
                key: bot.id,
                bot: bot,
                docker: data.docker,
                localImages: localImages,
                busy: busy,
                t: t,
                onChat: handleChat,
                onEdit: openEdit,
                onDelete: openDelete,
                onVmAction: runVmAction,
                onNotifyTest: runNotifyTest,
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
          defaultImage: data.defaultImage,
          onCancel: closeDialog,
          onSubmit: saveBot,
        })
      } else if (dialog && dialog.kind === 'delete') {
        dialogNode = h(DeleteDialog, {
          key: 'delete',
          t: t,
          bot: dialog.bot,
          onCancel: closeDialog,
          onConfirm: confirmDelete,
        })
      } else if (dialog && dialog.kind === 'removeVm') {
        dialogNode = h(ConfirmDialog, {
          key: 'removeVm',
          t: t,
          title: t('vmRemoveTitle', { name: dialog.bot.name }),
          description: t('vmRemoveBody'),
          confirmLabel: t('vmRemove'),
          destructive: true,
          onCancel: closeDialog,
          onConfirm: confirmVmRemove,
        })
      }

      // One root carries the theme variables for the page AND for the dialog
      // and toast layers, which render as siblings of the scrolling page.
      return h('div', { className: 'dsh-bots-root' },
        h('style', { key: 'dsh-bots-styles' }, STYLES),
        h('div', { className: 'dsh-bots-page' },
          h('div', { className: 'dsh-bots-inner' },
            h('header', { className: 'dsh-bots-head' },
              h('div', { className: 'dsh-bots-heading' },
                h('h1', { className: 'dsh-bots-title' }, t('title')),
                h('p', { className: 'dsh-bots-intro' }, t('subtitle'))
              ),
              toolbar
            ),
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

    /** Navigate to a bot chat through the workspace service (main slot injection). */
    function makeStartSession(ctx, t) {
      return function startBotSession(workspaceId) {
        if (typeof workspaceId !== 'string' || !workspaceId) throw new Error(t('chatUnavailable'))
        const service = readService(ctx, 'uiWorkspace')
        if (!service || typeof service.startSession !== 'function') throw new Error(t('chatUnavailable'))
        service.startSession(workspaceId)
      }
    }

    /** Services the registrations need; `uiWorkspace` gates the chat navigation. */
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
      const startSession = makeStartSession(ctx, t)

      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: function () {
            const face = { t: t, startSession: startSession }
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
