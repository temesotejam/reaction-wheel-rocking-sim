from pathlib import Path
import re

app_path = Path('docs/app.js')
idx_path = Path('docs/index.html')
app = app_path.read_text(encoding='utf-8')
idx = idx_path.read_text(encoding='utf-8')

# Remove the temporary comparison-mode selector from the controller core.
app = app.replace('    "controlMode","initialPeakDeg","targetDeg","currentMa","peakDeadbandDeg","simSeconds",\n',
                  '    "initialPeakDeg","targetDeg","currentMa","peakDeadbandDeg","simSeconds",\n')
app = app.replace('      controlMode: els.controlMode ? els.controlMode.value : "direct_one_shot",\n', '')
app = app.replace('    let oneShotIssued = false;\n', '')

app = re.sub(
    r'decisionText: p\.controlMode === "direct_one_shot" \? "START_KICK後の最初のピークを使用。最初のzero-crossで目標Qを1回だけ投入します。" : "最初のピークを現在状態として使用",',
    'decisionText: "START_KICK後の最初の実ピークを現在状態として使用。以後は通常の目標追従閉ループです。",',
    app
)

app = re.sub(
    r'''        if \(pendingEvent && pendingEvent\.nextSide === side && pendingEvent\.actualPeakDeg == null\) \{\n          if \(p\.controlMode === "direct_one_shot"\) \{\n            pendingEvent\.actualPeakDeg = amp;\n            pendingEvent\.peakErrorDeg = p\.targetDeg - amp;\n            pendingEvent\.iAfter = 0;\n          \} else \{\n            updateIntegralAfterPeak\(pendingEvent, amp, state, p\);\n          \}\n          pendingEvent = null;\n        \}''',
    '''        if (pendingEvent && pendingEvent.nextSide === side && pendingEvent.actualPeakDeg == null) {\n          updateIntegralAfterPeak(pendingEvent, amp, state, p);\n          pendingEvent = null;\n        }''',
    app
)

app = re.sub(
    r'''        const directMode = p\.controlMode === "direct_one_shot";\n        const iSide = directMode \? 0 : iForSide\(nextSide, state\);\n        let qCmd = 0;\n        let action = "PASSIVE";\n        if \(directMode\) \{.*?        \} else \{\n          if \(Afree < p\.targetDeg - p\.peakDeadbandDeg\) qCmd = Math\.max\(0, ff\.qFF \+ iSide\);\n          action = qCmd > 0 \? "CLOSED_LOOP_INPUT" : "CLOSED_LOOP_HOLD";\n        \}\n''',
    '''        const iSide = iForSide(nextSide, state);\n        let qCmd = 0;\n        if (Afree < p.targetDeg - p.peakDeadbandDeg) qCmd = Math.max(0, ff.qFF + iSide);\n        const action = qCmd > 0 ? "TARGET_TRACK_INPUT" : "TARGET_TRACK_HOLD";\n''',
    app,
    flags=re.S
)

app = app.replace('          action, controlMode:p.controlMode,\n', '          action,\n')

app = re.sub(
    r'''          text: directMode\n            \? \(qCmd > 0.*?            : \(qCmd > 0\n                \? `ZC #\$\{zcCount\}: Aₖ=\$\{lastPeakDeg\.toFixed\(3\)\}° → Afree=\$\{Afree\.toFixed\(3\)\}° → Qff=\$\{ff\.qFF\.toFixed\(3\)\} \+ I\$\{sideText\(nextSide\)\}=\$\{iSide\.toFixed\(3\)\} → Qcmd=\$\{qCmd\.toFixed\(3\)\} mA·s\$\{modelSupported \? "" : " \[gモデル外挿\]"\}\$\{wheelFeasible \? "" : " \[RW回転数能力超過\]"\}`\n                : `ZC #\$\{zcCount\}: Afree=\$\{Afree\.toFixed\(3\)\}°。目標\$\{p\.targetDeg\.toFixed\(3\)\}°以上/不感帯内なのでQ=0（ブレーキなし）`\)''',
    '''          text: qCmd > 0\n            ? `ZC #${zcCount}: Aₖ=${lastPeakDeg.toFixed(3)}° → Afree=${Afree.toFixed(3)}° → 目標${p.targetDeg.toFixed(3)}°へ Qff=${ff.qFF.toFixed(3)} + I${sideText(nextSide)}=${iSide.toFixed(3)} → Qcmd=${qCmd.toFixed(3)} mA·s${modelSupported ? "" : " [gモデル外挿]"}${wheelFeasible ? "" : " [RW回転数能力超過]"}`\n            : `ZC #${zcCount}: Afree=${Afree.toFixed(3)}°。目標${p.targetDeg.toFixed(3)}°以上/不感帯内なのでQ=0（ブレーキなし）`''',
    app,
    flags=re.S
)

app = app.replace('    return { samples, events, peaks, saturated, invalid, modelExtrapolated, controlMode:p.controlMode };\n',
                  '    return { samples, events, peaks, saturated, invalid, modelExtrapolated };\n')
app = re.sub(
    r'function setStatus\(run\) \{let text=run\.controlMode === "direct_one_shot" \? "DIRECT ONE-SHOT" : "PEAK MODEL CONTROL",color="#7ee0b8";',
    'function setStatus(run) {let text="START KICK → TARGET TRACK",color="#7ee0b8";',
    app
)

# UI: no special BUILD_UP / one-shot mode. One start kick is represented by its measured first peak.
idx = re.sub(
    r'<div class="panel-head compact"><div><h2>Peak-model controller</h2><p>Direct one-shotでは最初のzero-crossだけ入力し、その後は完全に自由減衰させます。</p></div></div>',
    '<div class="panel-head compact"><div><h2>Peak-model controller</h2><p>START_KICKは最初の1回だけ。得られた最初のピーク以降は、増幅専用モードを使わず通常の目標角閉ループだけで追従します。</p></div></div>',
    idx
)
idx = re.sub(
    r'''        <label>制御モード\n          <select id="controlMode">\n            <option value="direct_one_shot" selected>Direct target one-shot（最初のZCだけ入力）</option>\n            <option value="closed_loop">Repeated half-cycle control（従来）</option>\n          </select>\n        </label>\n''',
    '',
    idx
)
idx = idx.replace('<label>最初の実ピーク A₀ [deg]', '<label>START_KICK後の最初の実ピーク A₀ [deg]')

idx = re.sub(
    r'<div class="controller-explain">.*?</div>\n      <div class="actions">',
    '''<div class="controller-explain">\n        <strong>基本動作：START_KICK 1回 → 通常目標追従</strong>\n        <code>START_KICK → 最初の実ピーク A₀</code>\n        <code>Afree,k+1 = F_s(Ak)</code>\n        <code>Qff = max(0, (Aref − Afree) / g_s)</code>\n        <code>Qcmd = max(0, Qff + I_s)</code>\n        <code>I_s ← I_s + KI(Aref − Aactual)</code>\n        <p>BUILD_UP専用の制御則はありません。Arefより振幅が小さければ通常の目標追従則が正のQを要求するため、その結果として振幅が増幅します。目標付近では必要Qが自然に小さくなります。</p>\n      </div>\n      <div class="actions">''',
    idx,
    flags=re.S
)

idx = idx.replace('START_KICK自体は、中央の二点接触からの離脱モデルに強く依存するため、この画面では「START_KICK後に得られた最初のピーク A₀」から本制御を検証します。START_KICKは別試験として追加します。',
                  'START_KICKは実機では最初の1回だけです。中央二点接触からの離脱は微小な左右差や柔軟性に依存し、過去のstartup測定もSTART_KICK単独効率を分離できていないため、現在はSTART_KICK後に実際に得られた最初のピーク A₀を初期条件として通常閉ループを評価します。')

idx = idx.replace('app.js?v=20260903-7', 'app.js?v=20260903-8')
idx = idx.replace('style.css?v=20260903-6', 'style.css?v=20260903-8')

if 'direct_one_shot' in app or 'Direct target one-shot' in idx:
    raise SystemExit('direct one-shot remnants remain')

app_path.write_text(app, encoding='utf-8')
idx_path.write_text(idx, encoding='utf-8')
print('normal closed-loop migration complete')
