from pathlib import Path

app_path = Path('docs/app.js')
s = app_path.read_text(encoding='utf-8')

def rep(old, new):
    global s
    if old not in s:
        raise SystemExit('missing app pattern:\n' + old[:240])
    s = s.replace(old, new, 1)

rep('"initialPeakDeg","targetDeg","currentMa","qMaxMas","peakDeadbandDeg","simSeconds",',
    '"initialPeakDeg","targetDeg","currentMa","peakDeadbandDeg","simSeconds",')
rep('"gPlus","gMinus","kiMasPerDeg","iLimitMas","predLossPlus","predLossMinus",',
    '"gPlus","gMinus","qModelMaxMas","kiMasPerDeg","iLimitMas","predLossPlus","predLossMinus",')
rep('"liveCycleMargin","liveMode","liveDecision","eventBody",',
    '"liveModelStatus","liveWheelHeadroom","liveMode","liveDecision","eventBody",')

rep('''    let lo = 0, hi = 0.001;
    while (progress(hi) < targetMag && hi < 0.25) hi *= 2;
    hi = Math.min(hi, 0.25);
    if (progress(hi) < targetMag) return hi;''',
    '''    let lo = 0, hi = 0.001, guard = 0;
    while (progress(hi) < targetMag && guard < 80) { hi *= 2; guard++; }
    if (!Number.isFinite(hi) || progress(hi) < targetMag) return NaN;''')

rep('''      currentMa: Math.max(1, finiteOr(parseFloat(els.currentMa.value), 300)),
      qMaxMas: Math.max(0.001, finiteOr(parseFloat(els.qMaxMas.value), 0.9)),
      peakDeadbandDeg:''',
    '''      currentMa: Math.max(1, finiteOr(parseFloat(els.currentMa.value), 300)),
      peakDeadbandDeg:''')
rep('''      gPlus: Math.max(1e-6, finiteOr(parseFloat(els.gPlus.value), 0.29)),
      gMinus: Math.max(1e-6, finiteOr(parseFloat(els.gMinus.value), 0.29)),
      kiMasPerDeg:''',
    '''      gPlus: Math.max(1e-6, finiteOr(parseFloat(els.gPlus.value), 0.29)),
      gMinus: Math.max(1e-6, finiteOr(parseFloat(els.gMinus.value), 0.29)),
      qModelMaxMas: Math.max(0.001, finiteOr(parseFloat(els.qModelMaxMas.value), 1.6)),
      kiMasPerDeg:''')

old_qff = '''  function qFeedForward(Afree, side, p) {
    if (Afree >= p.targetDeg - p.peakDeadbandDeg) {
      return { qFF: 0, eFree: potential(side * Afree * DEG, p), eRef: potential(side * p.targetDeg * DEG, p), deltaE: 0 };
    }
    const eFree = potential(side * Afree * DEG, p);
    const eRef = potential(side * p.targetDeg * DEG, p);
    const deltaE = eRef - eFree;
    const g = gainForSide(side, p);
    let lo = 0, hi = p.qMaxMas;
    for (let k = 0; k < 50; k++) {
      const mid = 0.5 * (lo + hi);
      const predA = Afree + g * mid;
      const e = potential(side * predA * DEG, p);
      if (e < eRef) lo = mid; else hi = mid;
    }
    return { qFF: 0.5 * (lo + hi), eFree, eRef, deltaE };
  }
'''
new_qff = '''  function qFeedForward(Afree, side, p) {
    const eFree = potential(side * Afree * DEG, p);
    const eRef = potential(side * p.targetDeg * DEG, p);
    if (Afree >= p.targetDeg - p.peakDeadbandDeg) {
      return { qFF: 0, eFree, eRef, deltaE: 0 };
    }
    const deltaE = eRef - eFree;
    const g = gainForSide(side, p);
    // U_s is monotonic in the controlled region, so the energy-matching solution
    // is equivalent to Afree + g_s Q = Aref. No artificial upper Q cap is applied.
    const qFF = Math.max(0, (p.targetDeg - Afree) / g);
    return { qFF, eFree, eRef, deltaE };
  }

  function wheelQHeadroomMas(wheelOmega, commandMa, p) {
    if (Math.abs(commandMa) < 1e-12) return Infinity;
    const dir = Math.sign(commandMa);
    const deltaOmega = p.maxWheelRadS - dir * wheelOmega;
    return Math.max(0, p.jw * deltaOmega / p.kt * 1000);
  }
'''
rep(old_qff, new_qff)

rep('''    const atHigh = event.qCmd >= p.qMaxMas - 1e-8;
    const atLow = event.qCmd <= 1e-8;
    if (!((atHigh && err > 0) || (atLow && err < 0))) {
      nextI = clamp(oldI + p.kiMasPerDeg * err, -p.iLimitMas, p.iLimitMas);
    }''',
    '''    const atLow = event.qCmd <= 1e-8;
    // Only the no-braking floor saturates Qcmd. There is no artificial upper Q cap.
    if (!(atLow && err < 0)) {
      nextI = clamp(oldI + p.kiMasPerDeg * err, -p.iLimitMas, p.iLimitMas);
    }''')

rep('''    let saturated = false, invalid = false;
    const state =''',
    '''    let saturated = false, invalid = false, modelExtrapolated = false;
    const state =''')
rep('''        controlState: "COAST", nextSide: 0, Afree: NaN, deltaE: 0, qFF: 0, qCmd: 0, cycleMargin: NaN,
        decisionText:''',
    '''        controlState: "COAST", nextSide: 0, Afree: NaN, deltaE: 0, qFF: 0, qCmd: 0,
        modelSupported: true, wheelQHeadroom: Infinity,
        decisionText:''')
rep('''          nextSide: currentDecision.nextSide, Afree: currentDecision.Afree, deltaE: currentDecision.deltaE,
          qFF: currentDecision.qFF, qCmd: currentDecision.qCmd, cycleMargin: currentDecision.cycleMargin,
          decisionText:''',
    '''          nextSide: currentDecision.nextSide, Afree: currentDecision.Afree, deltaE: currentDecision.deltaE,
          qFF: currentDecision.qFF, qCmd: currentDecision.qCmd,
          modelSupported: currentDecision.modelSupported, wheelQHeadroom: currentDecision.wheelQHeadroom,
          decisionText:''')

rep('''      if (Math.abs(wheelOmega) >= p.maxWheelRadS && wouldIncreaseWheel) { tauMotor = 0; saturated = true; }''',
    '''      if (Math.abs(wheelOmega) >= p.maxWheelRadS && wouldIncreaseWheel) {
        tauMotor = 0;
        saturated = true;
        activePulse = null;
        if (pendingEvent) pendingEvent.actuatorLimited = true;
      }''')
rep('''      if (Math.abs(wheelOmega) > p.maxWheelRadS) { wheelOmega = Math.sign(wheelOmega) * p.maxWheelRadS; saturated = true; }''',
    '''      if (Math.abs(wheelOmega) > p.maxWheelRadS) {
        wheelOmega = Math.sign(wheelOmega) * p.maxWheelRadS;
        saturated = true;
        activePulse = null;
        if (pendingEvent) pendingEvent.actuatorLimited = true;
      }''')

old_zc = '''        let qCmd = 0;
        if (Afree < p.targetDeg - p.peakDeadbandDeg) qCmd = clamp(ff.qFF + iSide, 0, p.qMaxMas);
        const g = gainForSide(nextSide,p);
        const cycleMargin = Afree + g * p.qMaxMas - lastPeakDeg;
        const commandMa = qCmd > 0 ? -Math.sign(omega || nextSide) * p.currentMa : 0;
        const signedQ = Math.sign(commandMa) * qCmd;
        const pulseWidth = qCmd > 0 ? solvePulseWidthForSignedQ(signedQ, currentActualMa, commandMa, p.tauFall) : 0;
        const event = {
          index: zcCount, t, nextSide, Ak:lastPeakDeg, Afree, deltaEMj:ff.deltaE*1000,
          qFF:ff.qFF, iUsed:iSide, qCmd, pulseWidthMs:pulseWidth*1000, cycleMargin,
          actualPeakDeg:null, peakErrorDeg:null, iAfter:null
        };'''
new_zc = '''        let qCmd = 0;
        if (Afree < p.targetDeg - p.peakDeadbandDeg) qCmd = Math.max(0, ff.qFF + iSide);
        const commandMa = qCmd > 0 ? -Math.sign(omega || nextSide) * p.currentMa : 0;
        const signedQ = Math.sign(commandMa) * qCmd;
        const pulseWidth = qCmd > 0 ? solvePulseWidthForSignedQ(signedQ, currentActualMa, commandMa, p.tauFall) : 0;
        const modelSupported = qCmd <= p.qModelMaxMas + 1e-9;
        if (!modelSupported) modelExtrapolated = true;
        const wheelQHeadroom = wheelQHeadroomMas(wheelOmega, commandMa, p);
        const wheelFeasible = !Number.isFinite(wheelQHeadroom) || qCmd <= wheelQHeadroom + 1e-9;
        const event = {
          index: zcCount, t, nextSide, Ak:lastPeakDeg, Afree, deltaEMj:ff.deltaE*1000,
          qFF:ff.qFF, iUsed:iSide, qCmd, pulseWidthMs:pulseWidth*1000,
          modelSupported, wheelQHeadroom, wheelFeasible, actuatorLimited:false,
          actualPeakDeg:null, peakErrorDeg:null, iAfter:null
        };'''
rep(old_zc, new_zc)

rep('''          text: qCmd > 0
            ? `ZC #${zcCount}: Aₖ=${lastPeakDeg.toFixed(3)}° → Afree=${Afree.toFixed(3)}° → Qff=${ff.qFF.toFixed(3)} + I${sideText(nextSide)}=${iSide.toFixed(3)} → Qcmd=${qCmd.toFixed(3)} mA·s`
            :''',
    '''          text: qCmd > 0
            ? `ZC #${zcCount}: Aₖ=${lastPeakDeg.toFixed(3)}° → Afree=${Afree.toFixed(3)}° → Qff=${ff.qFF.toFixed(3)} + I${sideText(nextSide)}=${iSide.toFixed(3)} → Qcmd=${qCmd.toFixed(3)} mA·s${modelSupported ? "" : " [gモデル外挿]"}${wheelFeasible ? "" : " [RW回転数能力超過]"}`
            :''')

rep('''    return { samples, events, peaks, saturated, invalid };''',
    '''    return { samples, events, peaks, saturated, invalid, modelExtrapolated };''')

rep('''["wheel",`${rpmFromRadS(s.wheelOmega).toFixed(0)} rpm`],["ΔAcycle",Number.isFinite(s.cycleMargin)?`${s.cycleMargin.toFixed(3)}°`:"—"]''',
    '''["wheel",`${rpmFromRadS(s.wheelOmega).toFixed(0)} rpm`],["g model",s.modelSupported?"IN RANGE":"EXTRAPOLATION"]''')

rep('''    els.liveRpm.textContent=rpmFromRadS(s.wheelOmega).toFixed(0);els.liveWheelAngle.textContent=(s.wheelAngle*RAD2DEG).toFixed(1);
    els.liveCycleMargin.textContent=Number.isFinite(s.cycleMargin)?s.cycleMargin.toFixed(3):"—";els.liveMode.textContent=prettyMode(s.mode);''',
    '''    els.liveRpm.textContent=rpmFromRadS(s.wheelOmega).toFixed(0);els.liveWheelAngle.textContent=(s.wheelAngle*RAD2DEG).toFixed(1);
    els.liveModelStatus.textContent=s.modelSupported?"IN RANGE":"EXTRAPOLATION";
    els.liveWheelHeadroom.textContent=Number.isFinite(s.wheelQHeadroom)?s.wheelQHeadroom.toFixed(1):"∞";
    els.liveMode.textContent=prettyMode(s.mode);''')

rep('''    const qMax=Math.max(p.qMaxMas,.1);chartRow(ctx,w,h,2,5,"Q cmd [mA·s]",0,qMax*1.15,[{data:a,value:s=>s.qCmd,color:"#ffd166"},{data:a,value:s=>s.qFF,color:"#ff9b72",dash:[4,3],width:1.2}],currentT,xMax,run.events,run.peaks);''',
    '''    const qMax=Math.max(.1,...a.map(s=>Math.max(s.qCmd,s.qFF)*1.1));chartRow(ctx,w,h,2,5,"Q cmd [mA·s]",0,qMax,[{data:a,value:s=>s.qCmd,color:"#ffd166"},{data:a,value:s=>s.qFF,color:"#ff9b72",dash:[4,3],width:1.2}],currentT,xMax,run.events,run.peaks);''')

rep('''      const vals=[e.index,e.t.toFixed(3),sideText(e.nextSide),e.Ak.toFixed(3),e.Afree.toFixed(3),e.deltaEMj.toFixed(4),e.qFF.toFixed(3),e.iUsed.toFixed(3),e.qCmd.toFixed(3),e.cycleMargin.toFixed(3),e.actualPeakDeg==null?"—":e.actualPeakDeg.toFixed(3),e.peakErrorDeg==null?"—":e.peakErrorDeg.toFixed(3)];''',
    '''      const vals=[e.index,e.t.toFixed(3),sideText(e.nextSide),e.Ak.toFixed(3),e.Afree.toFixed(3),e.deltaEMj.toFixed(4),e.qFF.toFixed(3),e.iUsed.toFixed(3),e.qCmd.toFixed(3),e.modelSupported?"IN":"EXTRAP",Number.isFinite(e.wheelQHeadroom)?e.wheelQHeadroom.toFixed(1):"∞",e.actualPeakDeg==null?"—":e.actualPeakDeg.toFixed(3),e.peakErrorDeg==null?"—":e.peakErrorDeg.toFixed(3)];''')

rep('''  function setStatus(run) {let text="PEAK MODEL CONTROL",color="#7ee0b8";if(run.invalid){text="MODEL LIMIT";color="#ff7474";}else if(run.saturated){text="WHEEL LIMIT";color="#ffd166";}els.statusBadge.textContent=text;els.statusBadge.style.color=color;els.statusBadge.style.borderColor=color;}''',
    '''  function setStatus(run) {let text="PEAK MODEL CONTROL",color="#7ee0b8";if(run.invalid){text="MODEL LIMIT";color="#ff7474";}else if(run.saturated){text="WHEEL LIMIT";color="#ffd166";}else if(run.modelExtrapolated){text="MODEL EXTRAPOLATION";color="#ffd166";}els.statusBadge.textContent=text;els.statusBadge.style.color=color;els.statusBadge.style.borderColor=color;}''')

if 'qMaxMas' in s or 'cycleMargin' in s or 'liveCycleMargin' in s:
    raise SystemExit('artificial Q-limit references remain in app.js')
app_path.write_text(s, encoding='utf-8')

idx_path = Path('docs/index.html')
h = idx_path.read_text(encoding='utf-8')
h = h.replace('''        <article class="live-card capability"><span>ΔAcycle @ Qmax</span><strong id="liveCycleMargin">—</strong><small>deg</small></article>''',
              '''        <article class="live-card capability"><span>g model</span><strong id="liveModelStatus">IN RANGE</strong></article>
        <article class="live-card capability"><span>RW Q headroom</span><strong id="liveWheelHeadroom">∞</strong><small>mA·s</small></article>''')
h = h.replace('''        <label>通常Q上限 [mA·s]
          <input id="qMaxMas" type="number" value="0.9" min="0.05" max="10" step="0.05">
        </label>
''', '')
h = h.replace('''          <label>g− [deg/(mA·s)] <span class="provisional">要実機確定</span>
            <input id="gMinus" type="number" value="0.290" min="0.001" max="5" step="0.001">
          </label>
          <label>KI''',
              '''          <label>g− [deg/(mA·s)] <span class="provisional">要実機確定</span>
            <input id="gMinus" type="number" value="0.290" min="0.001" max="5" step="0.001">
          </label>
          <label>g同定Q上限 [mA·s] <span class="provisional">警告のみ・制御は切らない</span>
            <input id="qModelMaxMas" type="number" value="1.6" min="0.05" max="50" step="0.05">
          </label>
          <label>KI''')
h = h.replace('<code>Qcmd = clip(Qff + I_s, 0, Qmax)</code>', '<code>Qcmd = max(0, Qff + I_s)</code>')
h = h.replace('''        <p>予測で目標以上ならQ=0（ブレーキなし）。固定gが妥当かも、このシミュレーションで検証対象にします。</p>''',
              '''        <p>予測で目標以上ならQ=0（ブレーキなし）。Qに人工的な上限は置きません。代わりに、gの同定範囲外は外挿警告、RW回転数は物理制約として判定します。</p>''')
h = h.replace('''        <th>#</th><th>tZC</th><th>next</th><th>Ak</th><th>Afree</th><th>ΔEreq[mJ]</th><th>Qff</th><th>I_s</th><th>Qcmd</th><th>ΔAcycle</th><th>Aactual</th><th>error</th>''',
              '''        <th>#</th><th>tZC</th><th>next</th><th>Ak</th><th>Afree</th><th>ΔEreq[mJ]</th><th>Qff</th><th>I_s</th><th>Qcmd</th><th>g model</th><th>RW Q headroom</th><th>Aactual</th><th>error</th>''')
h = h.replace('''        <p><strong>制御能力:</strong> <code>ΔAcycle = F_s(A)+g_sQmax−A</code> が正なら最大入力で増幅可能。</p>
        <p><strong>限界:</strong> ΔAcycle&lt;0の領域では通常制御だけでは振幅を増やせません。</p>''',
              '''        <p><strong>Q指令:</strong> <code>Qcmd = max(0, Qff + I_s)</code>。人工的なQ上限では切りません。</p>
        <p><strong>モデル信頼性:</strong> Qcmdがgの同定範囲を超えたら外挿として明示します。</p>
        <p><strong>物理限界:</strong> RW回転数上限・足裏モデル限界など、実際の制約に当たった場合にのみ制御能力不足と判定します。</p>''')
h = h.replace('<script src="app.js?v=20260903-4"></script>', '<script src="app.js?v=20260903-5"></script>')
h = h.replace('前回ピークを状態として保存し、自由減衰モデル <code>F_s(A_k)</code> で次ピークを先読み。zero-crossで不足分だけQを入れ、実ピーク誤差を左右別I項へ学習します。',
              '前回ピークを状態として保存し、自由減衰モデル <code>F_s(A_k)</code> で次ピークを先読み。zero-crossで必要Qをそのまま指令し、実ピーク誤差を左右別I項へ学習します。Qに人工的な上限は置きません。')
if 'qMaxMas' in h or '通常Q上限' in h or 'ΔAcycle' in h:
    raise SystemExit('artificial Q-limit UI references remain in index.html')
idx_path.write_text(h, encoding='utf-8')
