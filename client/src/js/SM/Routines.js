Ext.ns('SM.Routines')

SM.Routines.stateText = {
  active: 'Active',
  disabled: 'Disabled',
  needsReview: 'Needs Review'
}

SM.Routines.statusText = {
  saved: 'Saved',
  submitted: 'Submitted'
}

// List responses truncate long match details; the full text comes from the routine's own GET.
SM.Routines.detailPreview = function (detail, detailTruncated) {
  return detailTruncated ? `${detail}…` : detail
}

// Routines grid cell renderers. The GridView override (overrides.js) has already HTML-encoded v; r.data
// is raw. A qtip attribute is decoded once and then inserted as HTML, so its text is encoded twice.
SM.Routines.renderers = {
  name: (v, md, r) => `<span ext:qtip="${SM.he(SM.he(r.data.description ?? ''))}">${v}</span>`,
  rule: (v, md, r) => [v, ...r.data.ruleIds.map(SM.he)].join('<br>'),
  matchDetail: (v, md, r) => SM.Routines.detailPreview(v, r.data.matchDetailTruncated)
}

// Why the API flagged a routine; needsReview itself is never decided here. Only a routine read with
// projection checks has currentChecks, which tell a changed check from a removed rule.
SM.Routines.needsReviewText = function ({ needsReview, stale, state, currentChecks }) {
  if (!needsReview) return ''
  if (stale) {
    if (!currentChecks) return 'Check content changed or rule removed'
    return currentChecks.length ? 'Check content changed' : 'No current rule has this STIG ID'
  }
  if (state === 'needsReview') return 'Marked for review'
  return 'Approver no longer exists'
}

// The one state a routine shows. A Manager's Disabled outranks the API's needsReview flag.
SM.Routines.displayState = function ({ state, needsReview }) {
  if (state === 'disabled') return 'disabled'
  return needsReview ? 'needsReview' : 'active'
}

// Which Routines toolbar buttons the selected routines allow. Details needs exactly one selected;
// a state change is offered when it applies to any selected routine, and a review takes every
// selected one that shows needsReview.
SM.Routines.buttonStates = function (routines, canManage) {
  const applies = state => canManage && SM.Routines.stateTargets(routines, state).length > 0
  return {
    details: routines.length === 1,
    enable: applies('active'),
    disable: applies('disabled'),
    markNeedsReview: applies('needsReview'),
    review: canManage && SM.Routines.reviewQueueIds(routines).length > 0,
    delete: canManage && routines.length > 0 && !SM.Routines.deleteRefusal(routines)
  }
}

// The routines a change to state applies to: Enable takes the disabled ones, Disable every one not
// already disabled, and Mark Needs Review the active ones.
SM.Routines.stateTargets = function (routines, state) {
  const appliesTo = {
    active: shown => shown === 'disabled',
    disabled: shown => shown !== 'disabled',
    needsReview: shown => shown === 'active'
  }[state]
  return routines.filter(routine => appliesTo(SM.Routines.displayState(routine)))
}

// Why the selected routines cannot be deleted, or '' when nothing prevents it.
SM.Routines.deleteRefusal = function (routines) {
  const count = routines.reduce((sum, routine) => sum + (routine.reviewCount ?? 0), 0)
  if (!count) return ''
  return `Referenced by ${count} review${count === 1 ? '' : 's'}; disable ${routines.length === 1 ? 'it' : 'them'} instead`
}

// The ids, in the given order, of the routines a review queue steps through.
SM.Routines.reviewQueueIds = function (routines) {
  return routines.filter(routine => SM.Routines.displayState(routine) === 'needsReview').map(routine => routine.routineId)
}

// What the Collection Review routine button does for a user with roleId: a Manager edits the review's
// routine or creates one from the review; a Full user sees the review's routine read-only. null: nothing.
SM.Routines.routineButtonMode = function (review, roleId) {
  if (roleId >= 3) return review.routine ? 'edit' : 'create'
  return roleId === 2 && review.routine ? 'details' : null
}

// The routines that may already have match: the same result and the same detail, byte for byte, once
// trimmed of the end spaces the API trims (MySQL TRIM, which keeps line breaks). A routine whose listed
// detail is truncated is kept while that detail begins the shown one; only its full detail decides.
SM.Routines.matchHolders = function (match, routines) {
  const detail = match.detail.replace(/^ +| +$/g, '')
  return routines.filter(({ match: held }) => held.result === match.result &&
    (held.detailTruncated ? detail.startsWith(held.detail) : detail === held.detail))
}

// Whether a match shown in the form differs from the stored one. A textarea reports every
// line break as \n, so a detail shown unedited still equals one stored with \r\n.
SM.Routines.matchChanged = function (shown, stored) {
  const lines = text => text.replace(/\r\n?/g, '\n')
  return shown.result !== stored.result || lines(shown.detail) !== lines(stored.detail)
}

// The match a save sends for the match shown: the server's, exactly as stored or derived, unless it
// was edited, because imports are matched against those exact bytes.
SM.Routines.sentMatch = function (shown, serverMatch) {
  return serverMatch && !SM.Routines.matchChanged(shown, serverMatch) ? serverMatch : shown
}

// The RoutineCreateFromMatch body.
SM.Routines.createBody = function ({ name, description, ruleId, match, action, serverMatch }) {
  return { name, description, ruleId, match: SM.Routines.sentMatch(match, serverMatch), action }
}

// The RoutineEdit body for the properties that changed. An unchanged action is left out
// because the API records the caller as approver whenever an action is sent.
SM.Routines.editPatch = function (routine, { name, description, match, action }) {
  const patch = {}
  if (name !== routine.name) patch.name = name
  if (description !== routine.description) patch.description = description
  if (SM.Routines.matchChanged(match, routine.match)) patch.match = match
  if (Object.keys(action).some(key => action[key] !== routine.action[key])) patch.action = action
  return patch
}

// A routine's default name: its Rule ID (SV-257777r925318_rule) without the _rule suffix.
SM.Routines.ruleName = function (ruleId) {
  return ruleId.replace(/_rule$/, '')
}

// The RoutineReapproval body for the check and the routine on display. The API refuses it (409)
// if either changed after it was read. A routine still carrying a default name takes the chosen rule's.
SM.Routines.reapprovalBody = function (routine, chosenCheck) {
  const body = { ruleId: chosenCheck.ruleId, reviewedCheckDigest: chosenCheck.checkDigest, reviewedApprovedTs: routine.approvedTs }
  if (/^SV-\d+r\d+$/.test(routine.name)) body.name = SM.Routines.ruleName(chosenCheck.ruleId)
  return body
}

SM.Routines.preformatted = text => `<pre style="white-space:pre-wrap;max-height:100px;overflow:auto">${SM.he(text)}</pre>`

// The review window's check text: the changes from the check text routine was approved against to the
// current check chosen, or, when no current rule has the routine's Version, that text as removed.
SM.Routines.checkHtml = function ({ version, approvedCheckContent }, check) {
  const notice = text => `<div class="x-grid-empty">${text}</div>`
  const diff = content => SM.renderTextDiff(approvedCheckContent, content, { name: 'check', outputFormat: 'line-by-line' })
  if (!check) {
    const removed = notice(`No current rule has STIG ID ${SM.he(version)}. Approve is unavailable; Disable or Skip this routine.`)
    return approvedCheckContent === null ? removed : removed + diff('')
  }
  if (approvedCheckContent === null) return notice('The previously approved check text is no longer stored') + SM.Routines.preformatted(check.content)
  return diff(check.content)
}

// The review queue's step after an action on step index of count, or null when the queue is done.
// A reload shows the same routine again.
SM.Routines.nextStep = function ({ index, count }, action) {
  const next = action === 'reload' ? index : index + 1
  return next < count ? { index: next, count } : null
}

// Shows the API's explanation of an expected refusal; any other failure is an application error.
SM.Routines.handleRefusal = function (e, title, statuses) {
  if (statuses.includes(e.status)) {
    Ext.Msg.alert(title, SM.he(JSON.parse(e.responseText).detail))
  }
  else {
    SM.Error.handleError(e)
  }
}

// Runs request on each item, size at a time, and settles them all, in order.
SM.Routines.settleInBatches = async function (items, request, size = 8) {
  const results = []
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.allSettled(items.slice(i, i + size).map(request)))
  }
  return results
}

// The collection's routines resource, or routineId's.
SM.Routines.url = function (collectionId, routineId) {
  const routinesUrl = `${STIGMAN.Env.apiBase}/collections/${collectionId}/routines`
  return routineId ? `${routinesUrl}/${routineId}` : routinesUrl
}

// A routine, read with the given query params.
SM.Routines.getRoutine = function ({ collectionId, routineId, params }) {
  return Ext.Ajax.requestPromise({ responseType: 'json', url: SM.Routines.url(collectionId, routineId), method: 'GET', params })
}

// The POST (no routineId) or PATCH request, without letting the app know.
SM.Routines.requestSave = function ({ collectionId, routineId, body }) {
  return Ext.Ajax.requestPromise({
    responseType: 'json',
    url: SM.Routines.url(collectionId, routineId),
    method: routineId ? 'PATCH' : 'POST',
    jsonData: body
  })
}

// Creates a routine (no routineId) or updates one, and lets the app know.
SM.Routines.saveRoutine = async function ({ collectionId, routineId, body }) {
  const routine = await SM.Routines.requestSave({ collectionId, routineId, body })
  SM.Dispatcher.fireEvent('routinechanged', collectionId, [routine])
  return routine
}

// Applies the same patch to several routines, lets the app know of every routine it changed at once,
// and then throws the first failure, if any.
SM.Routines.patchRoutines = async function ({ collectionId, routineIds, body }) {
  const results = await SM.Routines.settleInBatches(routineIds, routineId => SM.Routines.requestSave({ collectionId, routineId, body }))
  const routines = results.filter(result => result.status === 'fulfilled').map(result => result.value)
  if (routines.length) SM.Dispatcher.fireEvent('routinechanged', collectionId, routines)
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
}

// Creates a routine for ruleId from a review's routineSource with the given action defaults,
// or shows an existing routine in full, editable unless readOnly.
SM.Routines.showRoutineWindow = async function ({ collectionId, routineId, ruleId, routineSource, action, readOnly = false }) {
  try {
    let routine = routineId && await SM.Routines.getRoutine({ collectionId, routineId })
    action = routine?.action ?? action
    const serverMatch = (routine ?? routineSource)?.match
    // The other routines a saved match must differ from (uk_match): those with the same review key. A new
    // routine takes the key of ruleId, which is in the ruleIds of every routine with that key.
    const sameKey = routine
      ? other => other.routineId !== routine.routineId && other.version === routine.version && other.checkDigest === routine.checkDigest
      : other => other.ruleIds.includes(ruleId)
    let keyRoutines = readOnly ? [] : (await Ext.Ajax.requestPromise({ responseType: 'json', url: SM.Routines.url(collectionId) })).filter(sameKey)

    const nameField = new Ext.form.TextField({
      fieldLabel: 'Name',
      allowBlank: false,
      maxLength: 64,
      anchor: '100%',
      readOnly,
      value: routine?.name ?? SM.Routines.ruleName(ruleId)
    })
    const descriptionField = new Ext.form.TextField({
      fieldLabel: 'Description',
      maxLength: 255,
      anchor: '100%',
      readOnly,
      value: routine?.description
    })
    const duplicateWarning = new Ext.form.DisplayField({
      hideLabel: true,
      hidden: true
    })
    const matchResultCombo = new SM.Review.Form.ResultCombo({
      allowBlank: false,
      readOnly: true
    })
    const matchDetailField = new Ext.form.TextArea({
      fieldLabel: 'Detail',
      allowBlank: false,
      anchor: '100%',
      height: 100,
      readOnly: true
    })
    const editMatchCheckbox = new Ext.form.Checkbox({
      boxLabel: 'Edit match',
      hideLabel: true,
      hidden: readOnly,
      listeners: {
        check: (checkbox, checked) => {
          matchResultCombo.setReadOnly(!checked)
          matchDetailField.setReadOnly(!checked)
          if (!checked) showMatch()
        }
      }
    })
    const resultCombo = new SM.Review.Form.ResultCombo({
      allowBlank: false,
      readOnly
    })
    // A routine never sets Not Reviewed, so a Not Reviewed review leaves the action result to choose.
    resultCombo.store.removeAt(resultCombo.store.find('result', 'notchecked'))
    if (resultCombo.store.find('result', action.result) !== -1) resultCombo.setValue(action.result)
    const detailField = new Ext.form.TextArea({
      fieldLabel: 'Detail',
      anchor: '100%',
      height: 100,
      emptyText: 'Keep the imported detail',
      maxLength: 32767,
      readOnly,
      value: action.detail
    })
    const commentField = new Ext.form.TextArea({
      fieldLabel: 'Comment',
      anchor: '100%',
      height: 100,
      emptyText: 'Keep the imported comment',
      readOnly,
      value: action.comment
    })
    const statusCombo = new Ext.form.ComboBox({
      fieldLabel: 'Status',
      mode: 'local',
      triggerAction: 'all',
      editable: false,
      allowBlank: false,
      readOnly,
      store: new Ext.data.SimpleStore({
        fields: ['status', 'statusStr'],
        data: Object.entries(SM.Routines.statusText)
      }),
      valueField: 'status',
      displayField: 'statusStr',
      value: action.status
    })
    const formPanel = new Ext.form.FormPanel({
      border: false,
      autoScroll: true,
      labelWidth: 90,
      monitorValid: true,
      items: [
        nameField,
        descriptionField,
        {
          xtype: 'fieldset',
          title: 'Match',
          items: [
            {
              xtype: 'displayfield',
              hideLabel: true,
              hidden: routine || routineSource,
              value: 'The review has no detail to match. Tick Edit match to enter one.'
            },
            duplicateWarning,
            matchResultCombo,
            matchDetailField,
            editMatchCheckbox
          ]
        },
        { xtype: 'fieldset', title: 'Action', items: [resultCombo, detailField, commentField, statusCombo] }
      ],
      listeners: {
        clientvalidation: (form, valid) => {
          const match = SM.Routines.sentMatch(shownMatch(), serverMatch)
          const key = JSON.stringify(match)
          if (key !== scheduledKey) {
            scheduledKey = key
            holderCheck.delay(300, null, null, [match, key])
          }
          saveBtn.setDisabled(!valid || key !== checkedKey || !!holder)
        }
      }
    })

    // A shown match is checked once the user pauses editing it; holder is the routine with the match whose
    // key is checkedKey, and saving waits until that is the match shown. A failed check finds no holder and
    // leaves a duplicate to the server, which refuses it (422).
    let scheduledKey, checkedKey, holder
    const holderCheck = new Ext.util.DelayedTask(async (match, key) => {
      let found
      try {
        found = await findHolder(match)
      }
      catch (e) {
        SM.Error.handleError(e)
      }
      if (key !== scheduledKey || appwindow.isDestroyed) return
      checkedKey = key
      holder = found
      duplicateWarning.setValue(holder && `<div class="x-form-invalid-msg" style="width:auto">Routine "${SM.he(holder.name)}" already has this match.</div>`)
      duplicateWarning.setVisible(!!holder)
      openHolderBtn.setVisible(!!holder)
    })

    // The routine with match, once the full detail of any truncated one that may equal it is read in.
    async function findHolder (match) {
      const truncated = SM.Routines.matchHolders(match, keyRoutines).filter(other => other.match.detailTruncated)
      const read = await Promise.all(truncated.map(other => SM.Routines.getRoutine({ collectionId, routineId: other.routineId })))
      keyRoutines = keyRoutines.map(other => read.find(full => full.routineId === other.routineId) ?? other)
      return SM.Routines.matchHolders(match, keyRoutines)[0]
    }

    function shownMatch () {
      return { result: matchResultCombo.getValue(), detail: matchDetailField.getValue() }
    }

    // The match the server holds, or would store for a new routine.
    function showMatch () {
      matchResultCombo.setValue(serverMatch?.result)
      matchDetailField.setValue(serverMatch?.detail)
    }

    async function save () {
      if (!formPanel.getForm().isValid()) return
      const values = {
        name: nameField.getValue(),
        description: descriptionField.getValue() || null,
        match: shownMatch(),
        action: {
          result: resultCombo.getValue(),
          detail: detailField.getValue() || null,
          comment: commentField.getValue() || null,
          status: statusCombo.getValue()
        }
      }
      try {
        if (routine) {
          const patch = SM.Routines.editPatch(routine, values)
          if (Object.keys(patch).length) await SM.Routines.saveRoutine({ collectionId, routineId: routine.routineId, body: patch })
        }
        else {
          const body = SM.Routines.createBody({ ...values, ruleId, serverMatch })
          await SM.Routines.saveRoutine({ collectionId, body })
        }
        appwindow.close()
      }
      catch (e) {
        SM.Routines.handleRefusal(e, 'Routine not saved', [422])
      }
    }

    const saveBtn = new Ext.Button({
      text: routine ? 'Save' : 'Create',
      handler: save
    })
    const openHolderBtn = new Ext.Button({
      text: 'Open routine',
      hidden: true,
      handler: () => {
        appwindow.close()
        SM.Routines.showRoutineWindow({ collectionId, routineId: holder.routineId })
      }
    })
    const appwindow = new Ext.Window({
      title: routine ? 'Routine' : 'Create Routine',
      cls: 'sm-dialog-window sm-round-panel',
      modal: true,
      width: 560,
      height: Math.min(650, Ext.getBody().getHeight() - 80),
      layout: 'fit',
      plain: true,
      bodyStyle: 'padding:10px;',
      buttonAlign: 'right',
      items: formPanel,
      buttons: readOnly
        ? [{ text: 'Close', handler: () => appwindow.close() }]
        : [
            openHolderBtn,
            { text: 'Cancel', handler: () => appwindow.close() },
            saveBtn
          ]
    })
    showMatch()
    appwindow.show()
  }
  catch (e) {
    SM.Error.handleError(e)
  }
}

// Steps through the needsReview routines routineIds, showing each one's match, action and approved
// check text against the current text, and approves, disables or skips it.
SM.Routines.showReviewQueue = function ({ collectionId, routineIds }) {
  const fetchRoutine = routineId => SM.Routines.getRoutine({ collectionId, routineId, params: { projection: 'checks' } })
  function prefetch (routineId) {
    if (!routineId) return null
    const request = fetchRoutine(routineId)
    request.catch(() => {}) // a failure is reported when its step is shown
    return { routineId, request }
  }

  let step = { index: 0, count: routineIds.length }
  let prefetched // the request for the next step's routine
  let routine // the routine on display
  let check // the routine's current check on display
  let busy // a request is in flight, and the window stays open until it settles

  const { preformatted } = SM.Routines
  const nameField = new Ext.form.DisplayField({ fieldLabel: 'Name' })
  const reasonField = new Ext.form.DisplayField({ fieldLabel: 'Reason' })
  const matchResultField = new Ext.form.DisplayField({ fieldLabel: 'Result' })
  const matchDetailField = new Ext.form.DisplayField({ fieldLabel: 'Detail' })
  const actionResultField = new Ext.form.DisplayField({ fieldLabel: 'Result' })
  const actionDetailField = new Ext.form.DisplayField({ fieldLabel: 'Detail' })
  const actionCommentField = new Ext.form.DisplayField({ fieldLabel: 'Comment' })
  const actionStatusField = new Ext.form.DisplayField({ fieldLabel: 'Status' })
  const ruleLabel = new Ext.form.DisplayField({ fieldLabel: 'Rule' })
  const ruleCombo = new Ext.form.ComboBox({
    fieldLabel: 'Rule',
    mode: 'local',
    triggerAction: 'all',
    editable: false,
    store: new Ext.data.JsonStore({ root: '', idProperty: 'ruleId', fields: ['ruleId', 'checkDigest', 'content'] }),
    valueField: 'ruleId',
    displayField: 'ruleId',
    listeners: {
      select: (combo, record) => showCheck(record.data)
    }
  })
  const checkPanel = new Ext.Panel({
    title: 'Check text: changes from approved to current',
    flex: 3,
    autoScroll: true
  })

  function showCheck (chosenCheck) {
    check = chosenCheck
    checkPanel.update(SM.Routines.checkHtml(routine, check))
  }

  function setBusy (value) {
    busy = value
    approveBtn.setDisabled(busy || !check)
    disableBtn.setDisabled(busy)
    skipBtn.setDisabled(busy)
  }

  async function showStep () {
    setBusy(true)
    appwindow.setTitle(`Review Routine ${step.index + 1} of ${step.count}`)
    const routineId = routineIds[step.index]
    const request = prefetched?.routineId === routineId ? prefetched.request : fetchRoutine(routineId)
    prefetched = prefetch(routineIds[step.index + 1])
    try {
      routine = await request
    }
    catch (e) {
      setBusy(false)
      appwindow.close()
      return SM.Error.handleError(e)
    }
    const { match, action, currentChecks } = routine
    nameField.setValue(SM.he(routine.name))
    reasonField.setValue(SM.Routines.needsReviewText(routine))
    matchResultField.setValue(renderResult(match.result))
    matchDetailField.setValue(preformatted(match.detail))
    actionResultField.setValue(renderResult(action.result))
    actionDetailField.setValue(action.detail === null ? 'Keep the imported detail' : preformatted(action.detail))
    actionCommentField.setValue(action.comment === null ? 'Keep the imported comment' : preformatted(action.comment))
    actionStatusField.setValue(SM.Routines.statusText[action.status])
    ruleLabel.setValue(currentChecks.length ? SM.he(currentChecks[0].ruleId) : `No current rule has STIG ID ${SM.he(routine.version)}`)
    ruleLabel.setVisible(currentChecks.length < 2)
    ruleCombo.setVisible(currentChecks.length > 1)
    ruleCombo.store.loadData(currentChecks)
    ruleCombo.setValue(currentChecks[0]?.ruleId)
    showCheck(currentChecks[0])
    setBusy(false)
    appwindow.doLayout()
  }

  function advance (action) {
    step = SM.Routines.nextStep(step, action)
    if (step) showStep()
    else appwindow.close()
  }

  async function save (action, body) {
    setBusy(true)
    try {
      await SM.Routines.saveRoutine({ collectionId, routineId: routine.routineId, body })
    }
    catch (e) {
      if (e.status !== 409) {
        SM.Routines.handleRefusal(e, 'Routine not saved', [422])
        return setBusy(false)
      }
      Ext.Msg.alert('Routine changed', 'The routine or its check text changed after it was shown. The current version is now shown; review it before approving.')
      action = 'reload'
    }
    setBusy(false)
    advance(action)
  }

  const approveBtn = new Ext.Button({
    text: 'Approve',
    handler: () => save('approve', SM.Routines.reapprovalBody(routine, check))
  })
  const disableBtn = new Ext.Button({
    text: 'Disable',
    handler: () => save('disable', { state: 'disabled' })
  })
  const skipBtn = new Ext.Button({
    text: 'Skip',
    handler: () => advance('skip')
  })
  const appwindow = new Ext.Window({
    title: 'Review Routine',
    resizable: true,
    cls: 'sm-dialog-window sm-round-panel',
    modal: true,
    width: Math.min(Math.floor(Ext.getBody().getWidth() * 0.75), 1280),
    height: Ext.getBody().getHeight() - 80,
    minWidth: 810,
    minHeight: 460,
    maximizable: true,
    layout: 'vbox',
    layoutConfig: {
      align: 'stretch'
    },
    plain: true,
    bodyStyle: 'padding:10px;',
    buttonAlign: 'right',
    listeners: {
      beforeclose: () => !busy
    },
    items: [
      {
        xtype: 'form',
        flex: 2,
        autoScroll: true,
        border: false,
        labelWidth: 70,
        items: [
          { xtype: 'fieldset', title: 'Routine', items: [nameField, reasonField, ruleLabel, ruleCombo] },
          {
            layout: 'column',
            border: false,
            defaults: { layout: 'form', border: false, columnWidth: 0.5 },
            items: [
              { style: 'padding-right:5px', items: { xtype: 'fieldset', title: 'Match', items: [matchResultField, matchDetailField] } },
              { style: 'padding-left:5px', items: { xtype: 'fieldset', title: 'Action', items: [actionResultField, actionDetailField, actionCommentField, actionStatusField] } }
            ]
          }
        ]
      },
      checkPanel
    ],
    buttons: [
      approveBtn,
      disableBtn,
      skipBtn,
      { text: 'Close', handler: () => appwindow.close() }
    ]
  })
  appwindow.show()
  showStep()
}

SM.Routines.Grid = Ext.extend(Ext.grid.GridPanel, {
  initComponent: function () {
    const { collectionId, canManage } = this
    const store = new Ext.data.JsonStore({
      grid: this,
      smMaskDelay: 250,
      proxy: new Ext.data.HttpProxy({ url: SM.Routines.url(collectionId), method: 'GET' }),
      root: '',
      idProperty: 'routineId',
      fields: [
        'routineId', 'name', 'description', 'state', 'needsReview', 'stale', 'ruleIds', 'version', 'reviewCount',
        { name: 'matchResult', mapping: 'match.result' },
        { name: 'matchDetail', mapping: 'match.detail' },
        { name: 'matchDetailTruncated', mapping: 'match.detailTruncated' },
        { name: 'actionResult', mapping: 'action.result' },
        { name: 'actionDetail', mapping: 'action.detail' },
        { name: 'actionComment', mapping: 'action.comment' },
        { name: 'actionStatus', mapping: 'action.status' },
        { name: 'approvedUsername', mapping: 'approvedUser.username' },
        'approvedTs',
        { name: 'displayState', convert: (v, routine) => SM.Routines.displayState(routine) }
      ],
      sortInfo: {
        field: 'name',
        direction: 'ASC'
      }
    })

    const sm = new Ext.grid.CheckboxSelectionModel({
      listeners: {
        selectionchange: () => {
          SM.SetCheckboxSelModelHeaderState(sm)
          setButtonStates(sm.getSelections())
        }
      }
    })
    const columns = [
      sm,
      {
        header: 'Name',
        width: 140,
        dataIndex: 'name',
        sortable: true,
        renderer: SM.Routines.renderers.name
      },
      {
        header: 'Rule',
        width: 180,
        dataIndex: 'version',
        sortable: true,
        renderer: SM.Routines.renderers.rule
      },
      {
        header: 'Match',
        width: 50,
        dataIndex: 'matchResult',
        sortable: true,
        renderer: renderResult
      },
      {
        header: 'Match detail',
        width: 200,
        dataIndex: 'matchDetail',
        renderer: SM.Routines.renderers.matchDetail
      },
      {
        header: 'Action',
        width: 50,
        dataIndex: 'actionResult',
        sortable: true,
        renderer: renderResult
      },
      {
        header: 'Action status',
        width: 50,
        dataIndex: 'actionStatus',
        sortable: true,
        renderer: renderStatuses
      },
      {
        header: 'State',
        width: 100,
        dataIndex: 'displayState',
        sortable: true,
        renderer: (v, md, r) => v === 'needsReview'
          ? `<span class="sm-grid-sprite sm-severity-high" ext:qtip="${SM.Routines.needsReviewText(r.data)}">${SM.Routines.stateText[v]}</span>`
          : SM.Routines.stateText[v]
      },
      {
        header: 'Reviews set',
        tooltip: 'Reviews whose current value this routine set; 0 means it can be deleted',
        width: 70,
        align: 'right',
        dataIndex: 'reviewCount',
        sortable: true
      },
      {
        header: 'Approved by',
        width: 100,
        dataIndex: 'approvedUsername',
        sortable: true
      },
      {
        header: 'Approved at',
        width: 130,
        dataIndex: 'approvedTs',
        sortable: true
      }
    ]

    const selected = () => sm.getSelected().data
    const selectedRoutines = () => store.getRange().filter(r => sm.isSelected(r)).map(r => r.data)
    const patchState = state => async () => {
      try {
        const routineIds = SM.Routines.stateTargets(selectedRoutines(), state).map(routine => routine.routineId)
        await SM.Routines.patchRoutines({ collectionId, routineIds, body: { state } })
      }
      catch (e) {
        SM.Error.handleError(e)
      }
    }
    const buttons = {
      details: new Ext.Button({
        iconCls: 'icon-edit',
        text: canManage ? 'Modify...' : 'Details...',
        handler: () => SM.Routines.showRoutineWindow({ collectionId, routineId: selected().routineId, readOnly: !canManage })
      }),
      enable: new Ext.Button({
        text: 'Enable',
        handler: patchState('active')
      }),
      disable: new Ext.Button({
        text: 'Disable',
        handler: patchState('disabled')
      }),
      markNeedsReview: new Ext.Button({
        text: 'Mark Needs Review',
        handler: patchState('needsReview')
      }),
      review: new Ext.Button({
        text: 'Review...',
        handler: () => SM.Routines.showReviewQueue({
          collectionId,
          routineIds: SM.Routines.reviewQueueIds(selectedRoutines())
        })
      }),
      delete: new Ext.Button({
        iconCls: 'icon-del',
        text: 'Delete...',
        handler: () => {
          const routines = selectedRoutines()
          const prompt = routines.length === 1 ? `Delete routine "${SM.he(routines[0].name)}"?` : `Delete ${routines.length} routines?`
          Ext.Msg.confirm('Delete Routine', prompt, async btn => {
            if (btn !== 'yes') return
            const results = await SM.Routines.settleInBatches(routines, routine =>
              Ext.Ajax.requestPromise({ url: SM.Routines.url(collectionId, routine.routineId), method: 'DELETE' }))
            store.remove(routines.filter((routine, i) => results[i].status === 'fulfilled').map(routine => store.getById(routine.routineId)))
            const failure = results.find(result => result.status === 'rejected')
            if (failure) SM.Routines.handleRefusal(failure.reason, 'Routine not deleted', [409])
          })
        }
      })
    }

    function setButtonStates (records) {
      const routines = records.map(r => r.data)
      const states = SM.Routines.buttonStates(routines, canManage)
      for (const [name, enabled] of Object.entries(states)) buttons[name].setDisabled(!enabled)
      buttons.delete.setTooltip(SM.Routines.deleteRefusal(routines))
    }
    setButtonStates([])

    function onRoutineChanged (changedCollectionId, routines) {
      if (changedCollectionId !== collectionId) return
      const selectedIds = sm.getSelections().map(record => record.id)
      store.loadData(routines, true)
      // The selection still holds the replaced records; selecting again puts the loaded ones in their place.
      if (routines.some(routine => selectedIds.includes(routine.routineId))) sm.selectRecords(selectedIds.map(id => store.getById(id)))
    }
    // A STIG assignment or pinned revision change decides which rules are current, and so which routines are stale.
    function onStigAssetsChanged (changedCollectionId) {
      if (changedCollectionId === collectionId) store.reload()
    }
    SM.Dispatcher.addListener('routinechanged', onRoutineChanged)
    SM.Dispatcher.addListener('stigassetschanged', onStigAssetsChanged)

    const config = {
      layout: 'fit',
      store,
      columns,
      sm,
      view: new SM.ColumnFilters.GridView({
        emptyText: 'No routines. Create one from a review in the Collection Review workspace.',
        deferEmptyText: false,
        markDirty: false
      }),
      tbar: [
        buttons.details, '-',
        buttons.enable, buttons.disable, buttons.markNeedsReview, buttons.review, '-',
        buttons.delete
      ],
      bbar: new Ext.Toolbar({
        items: [
          {
            xtype: 'tbbutton',
            iconCls: 'icon-refresh',
            tooltip: 'Reload this grid',
            width: 20,
            handler: () => {
              const savedSmMaskDelay = store.smMaskDelay
              store.smMaskDelay = 0
              store.reload()
              store.smMaskDelay = savedSmMaskDelay
            }
          },
          { xtype: 'tbseparator' },
          {
            xtype: 'exportbutton',
            hasMenu: false,
            gridBasename: 'CollectionRoutines',
            exportType: 'grid',
            iconCls: 'sm-export-icon',
            text: 'CSV',
            grid: this
          },
          { xtype: 'tbfill' },
          { xtype: 'tbseparator' },
          new SM.RowCountTextItem({ store, noun: 'routine', iconCls: 'sm-setting-icon' })
        ]
      }),
      listeners: {
        // Ticking a checkbox twice quickly is not a request to open the routine.
        rowdblclick: (grid, rowIndex, e) => {
          if (!e.getTarget('.x-grid3-td-checker')) buttons.details.handler()
        },
        beforedestroy: () => {
          SM.Dispatcher.removeListener('routinechanged', onRoutineChanged)
          SM.Dispatcher.removeListener('stigassetschanged', onStigAssetsChanged)
        }
      }
    }
    Ext.apply(this, Ext.apply(this.initialConfig, config))
    this.superclass().initComponent.call(this)
  },

  initPanel: function () {
    this.store.load()
  }
})
