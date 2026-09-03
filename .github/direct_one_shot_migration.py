from pathlib import Path

app_path = Path('docs/app.js')
html_path = Path('docs/index.html')
app = app_path.read_text(encoding='utf-8')
html = html_path.read_text(encoding='utf-8')

# DOM / params
old = '"initialPeakDeg","targetDeg","currentMa","peakDeadbandDeg","simSeconds",'
new = '"controlMode","initialPeakDeg","targetDeg","currentMa","peakDeadbandDeg","simSeconds",'
assert old in app
app = app.replace(old, new, 1)

old = '    const p = {\n      initialPeakDeg: Math.max(0.01, finiteOr(parseFloat(els.initialPeakDeg.value), 0.8)),'
new = '    const p = {\n      controlMode: els.controlMode ? els.controlMode.value : "direct_one_shot",\n      initialPeakDeg: Math.max(0.01, finiteOr(parseFloat(els.initialPeakDeg.value), 0.8)),'
assert old in app
app = app.replace(old, new, 1)

# One-shot state
old = '    let currentDecision = null;\n    let pendingEvent = null;\n    let saturated = false, invalid = false, modelExtrapolated = false;'
new = '    let currentDecision = null;\n    let pendingEvent = null;\n    let oneShotIssued = false;\n    let saturated = false, invalid = false, modelExtrapolated = false;'
assert old in app
app = app.replace(old, new, 1)

# Initial live message
old = '        decisionText: "最初のピークを現在状態として使用", mode: contactMode(theta,p)'
new = '        decisionText: p.controlMode === "direct_one_shot" ? "START_KICK後の最初のピークを使用。最初のzero-crossで目標Qを1回だけ投入します。" : "最初のピークを現在状態として使用", mode: contactMode(theta,p)'
assert old in app
app = app.replace(old, new, 1)

# Peak feedback: no I learning in direct-one-shot mode
old = '''        if (pendingEvent && pendingEvent.nextSide === side && pendingEvent.actualPeakDeg == null) {
          updateIntegralAfterPeak(pendingEvent, amp, state, p);
          pendingEvent = null;
        }'''
new = '''        if (pendingEvent && pendingEvent.nextSide === side && pendingEvent.actualPeakDeg == null) {
          if (p.controlMode === "direct_one_shot") {
            pendingEvent.actualPeakDeg = amp;
            pendingEvent.peakErrorDeg = p.targetDeg - amp;
            pendingEvent.iAfter = 0;
          } else {
            updateIntegralAfterPeak(pendingEvent, amp, state, p);
          }
          pendingEvent = null;
        }'''
assert old in app
app = app.replace(old, new, 1)

# Zero-cross command generation
old = '''        const iSide = iForSide(nextSide, state);
        let qCmd = 0;
        if (Afree < p.targetDeg - p.peakDeadbandDeg) qCmd = Math.max(0, ff.qFF + iSide);
        const commandMa = qCmd > 0 ? -Math.sign(omega || nextSide) * p.currentMa : 0;'''
new = '''        const directMode = p.controlMode === "direct_one_shot";
        const iSide = directMode ? 0 : iForSide(nextSide, state);
        let qCmd = 0;
        let action = "PASSIVE";
        if (directMode) {
          if (!oneShotIssued) {
            if (Afree < p.targetDeg - p.peakDeadbandDeg) qCmd = Math.max(0, ff.qFF);
            oneShotIssued = true;
            action = qCmd > 0 ? "DIRECT_ONE_SHOT" : "DIRECT_ONE_SHOT_NO_INPUT";
          } else {
            qCmd = 0;
            action = "PASSIVE_AFTER_ONE_SHOT";
          }
        } else {
          if (Afree < p.targetDeg - p.peakDeadbandDeg) qCmd = Math.max(0, ff.qFF + iSide);
          action = qCmd > 0 ? "CLOSED_LOOP_INPUT" : "CLOSED_LOOP_HOLD";
        }
        const commandMa = qCmd > 0 ? -Math.sign(omega || nextSide) * p.currentMa : 0;'''
assert old in app
app = app.replace(old, new, 1)

# Event stores mode/action
old = '''          qFF:ff.qFF, iUsed:iSide, qCmd, pulseWidthMs:pulseWidth*1000,
          modelSupported, wheelQHeadroom, wheelFeasible, actuatorLimited:false,'''
new = '''          qFF:ff.qFF, iUsed:iSide, qCmd, pulseWidthMs:pulseWidth*1000,
          action, controlMode:p.controlMode,
          modelSupported, wheelQHeadroom, wheelFeasible, actuatorLimited:false,'''
assert old in app
app = app.replace(old, new, 1)

# Decision text
old = '''          text: qCmd > 0
            ? `ZC #${zcCount}: Aₖ=${lastPeakDeg.toFixed(3)}° → Afree=${Afree.toFixed(3)}° → Qff=${ff.qFF.toFixed(3)} + I${sideText(nextSide)}=${iSide.toFixed(3)} → Qcmd=${qCmd.toFixed(3)} mA·s${modelSupported ? "" : " [gモデル外挿]"}${wheelFeasible ? "" : " [RW回転数能力超過]"}`
            : `ZC #${zcCount}: Afree=${Afree.toFixed(3)}°。目標${p.targetDeg.toFixed(3)}°以上/不感帯内なのでQ=0（ブレーキなし）`'''
new = '''          text: directMode
            ? (qCmd > 0
                ? `DIRECT ONE-SHOT: ZC #${zcCount}: Aₖ=${lastPeakDeg.toFixed(3)}° → Afree=${Afree.toFixed(3)}° → 目標${p.targetDeg.toFixed(3)}°へ Qdirect=${qCmd.toFixed(3)} mA·s を1回だけ投入${modelSupported ? "" : " [gモデル外挿]"}${wheelFeasible ? "" : " [RW回転数能力超過]"}`
                : `DIRECT ONE-SHOT投入済み。ZC #${zcCount}以降は不足していてもQ=0で自由減衰`)
            : (qCmd > 0
                ? `ZC #${zcCount}: Aₖ=${lastPeakDeg.toFixed(3)}° → Afree=${Afree.toFixed(3)}° → Qff=${ff.qFF.toFixed(3)} + I${sideText(nextSide)}=${iSide.toFixed(3)} → Qcmd=${qCmd.toFixed(3)} mA·s${modelSupported ? "" : " [gモデル外挿]"}${wheelFeasible ? "" : " [RW回転数能力超過]"}`
                : `ZC #${zcCount}: Afree=${Afree.toFixed(3)}°。目標${p.targetDeg.toFixed(3)}°以上/不感帯内なのでQ=0（ブレーキなし）`)'''
assert old in app
app = app.replace(old, new, 1)

# Return mode and status label
old = '    return { samples, events, peaks, saturated, invalid, modelExtrapolated };'
new = '    return { samples, events, peaks, saturated, invalid, modelExtrapolated, controlMode:p.controlMode };'
assert old in app
app = app.replace(old, new, 1)

old = '  function setStatus(run) {let text="PEAK MODEL CONTROL",color="#7ee0b8";if(run.invalid){text="MODEL LIMIT";color="#ff7474";}else if(run.saturated){text="WHEEL LIMIT";color="#ffd166";}else if(run.modelExtrapolated){text="MODEL EXTRAPOLATION";color="#ffd166";}els.statusBadge.textContent=text;els.statusBadge.style.color=color;els.statusBadge.style.borderColor=color;}'
new = '  function setStatus(run) {let text=run.controlMode === "direct_one_shot" ? "DIRECT ONE-SHOT" : "PEAK MODEL CONTROL",color="#7ee0b8";if(run.invalid){text+=" / MODEL LIMIT";color="#ff7474";}else if(run.saturated){text+=" / WHEEL LIMIT";color="#ffd166";}else if(run.modelExtrapolated){text+=" / MODEL EXTRAPOLATION";color="#ffd166";}els.statusBadge.textContent=text;els.statusBadge.style.color=color;els.statusBadge.style.borderColor=color;}'
assert old in app
app = app.replace(old, new, 1)

# HTML: cache bust, lead, mode selector and explanation
assert 'app.js?v=20260903-6' in html
html = html.replace('app.js?v=20260903-6', 'app.js?v=20260903-7')
old = '<p class="lead">前回ピークを状態として保存し、自由減衰モデル <code>F_s(A_k)</code> で次ピークを先読み。zero-crossで必要Qをそのまま指令し、実ピーク誤差を左右別I項へ学習します。Qに人工的な上限は置きません。</p>'
new = '<p class="lead">START_KICK後の最初のピークから、目標値に必要なQを最初のzero-crossで1回だけ入れるDirect one-shotと、従来の半周期閉ループ制御を比較できます。既定はDirect one-shotです。</p>'
assert old in html
html = html.replace(old, new, 1)

old = '''      <div class="form-grid">
        <label>最初の実ピーク A₀ [deg]'''
new = '''      <div class="form-grid">
        <label>制御モード
          <select id="controlMode">
            <option value="direct_one_shot" selected>Direct target one-shot（最初のZCだけ入力）</option>
            <option value="closed_loop">Repeated half-cycle control（従来）</option>
          </select>
        </label>
        <label>最初の実ピーク A₀ [deg]'''
assert old in html
html = html.replace(old, new, 1)

old = '<div class="panel-head compact"><div><h2>Peak-model controller</h2><p>1半周期を1ステップとして制御します。</p></div></div>'
new = '<div class="panel-head compact"><div><h2>Peak-model controller</h2><p>Direct one-shotでは最初のzero-crossだけ入力し、その後は完全に自由減衰させます。</p></div></div>'
assert old in html
html = html.replace(old, new, 1)

old = '<strong>正式に採用する半周期制御則</strong>'
new = '<strong>比較する入力方式</strong>\n        <code>Direct one-shot: Qdirect = Qff(A₀→Aref), 最初のZCで1回だけ</code>\n        <code>その後: Q=0（増幅制御なし）</code>\n        <strong>Repeated mode</strong>'
assert old in html
html = html.replace(old, new, 1)

app_path.write_text(app, encoding='utf-8')
html_path.write_text(html, encoding='utf-8')
print('direct one-shot migration complete')
