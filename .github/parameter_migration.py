from pathlib import Path

app_path = Path('docs/app.js')
s = app_path.read_text(encoding='utf-8')

def rep(old, new):
    global s
    if old not in s:
        raise SystemExit('missing app pattern:\n' + old[:300])
    s = s.replace(old, new, 1)

rep('"gPlus","gMinus","qModelMaxMas","kiMasPerDeg","iLimitMas","predLossPlus","predLossMinus",',
    '"gPlus","gMinus","qModelMinMas","qModelMaxMas","kiMasPerDeg","iLimitMas","predLossPlus","predLossMinus",')
rep('"tauFallMs","kt","jw","maxRpm","massKg","icg","viscous","coulomb","dtMs","validationMsg",',
    '"tauFallMs","kt","jw","maxRpm","massKg","ieff","viscous","coulomb","dtMs","validationMsg",')

rep('''      gPlus: Math.max(1e-6, finiteOr(parseFloat(els.gPlus.value), 0.29)),
      gMinus: Math.max(1e-6, finiteOr(parseFloat(els.gMinus.value), 0.29)),
      qModelMaxMas: Math.max(0.001, finiteOr(parseFloat(els.qModelMaxMas.value), 1.6)),''',
    '''      gPlus: Math.max(1e-6, finiteOr(parseFloat(els.gPlus.value), 0.290316)),
      gMinus: Math.max(1e-6, finiteOr(parseFloat(els.gMinus.value), 0.254547)),
      qModelMinMas: Math.max(0, finiteOr(parseFloat(els.qModelMinMas.value), 0.454)),
      qModelMaxMas: Math.max(0.001, finiteOr(parseFloat(els.qModelMaxMas.value), 1.197)),''')
rep('''      kt: Math.max(1e-7, finiteOr(parseFloat(els.kt.value), 0.05)),
      jw: Math.max(1e-9, finiteOr(parseFloat(els.jw.value), 0.00008)),
      maxRpm: Math.max(100, finiteOr(parseFloat(els.maxRpm.value), 6000)),
      mass: Math.max(0.001, finiteOr(parseFloat(els.massKg.value), 0.1997)),
      icg: Math.max(1e-8, finiteOr(parseFloat(els.icg.value), 0.00055)),
      viscous: Math.max(0, finiteOr(parseFloat(els.viscous.value), 0.00012)),
      coulomb: Math.max(0, finiteOr(parseFloat(els.coulomb.value), 0.00005)),''',
    '''      kt: Math.max(1e-7, finiteOr(parseFloat(els.kt.value), 0.036)),
      jw: Math.max(1e-9, finiteOr(parseFloat(els.jw.value), 0.000021)),
      maxRpm: Math.max(100, finiteOr(parseFloat(els.maxRpm.value), 1050)),
      mass: Math.max(0.001, finiteOr(parseFloat(els.massKg.value), 0.1997)),
      ieff: Math.max(1e-8, finiteOr(parseFloat(els.ieff.value), 0.00090)),
      viscous: Math.max(0, finiteOr(parseFloat(els.viscous.value), 0.00050)),
      coulomb: Math.max(0, finiteOr(parseFloat(els.coulomb.value), 0.0)),''')

old_inertia = '''  function effectiveInertia(theta, p) {
    const a = Math.abs(theta);
    if (a <= p.thetaInner) return p.icg + p.mass * (p.h * p.h + p.innerX * p.innerX);
    return p.icg + p.mass * (p.radius * p.radius + p.d * p.d - 2 * p.radius * p.d * Math.cos(theta));
  }

  function inertiaDerivative(theta, p) {
    if (Math.abs(theta) <= p.thetaInner) return 0;
    return 2 * p.mass * p.radius * p.d * Math.sin(theta);
  }
'''
new_inertia = '''  // Effective roll inertia identified from passive free-decay periods.
  // This is deliberately an empirical Ieff, not CAD/CG inertia. The previous
  // rigid-body Icg + translation expression could not reproduce the measured
  // ~0.71--0.77 s periods with a physically positive Icg.
  function effectiveInertia(theta, p) { return p.ieff; }
  function inertiaDerivative(theta, p) { return 0; }
'''
rep(old_inertia, new_inertia)

rep('''        const modelSupported = qCmd <= p.qModelMaxMas + 1e-9;''',
    '''        const modelSupported = qCmd <= 1e-9 || (qCmd >= p.qModelMinMas - 1e-9 && qCmd <= p.qModelMaxMas + 1e-9);''')

app_path.write_text(s, encoding='utf-8')

idx_path = Path('docs/index.html')
h = idx_path.read_text(encoding='utf-8')

def hrep(old, new):
    global h
    if old not in h:
        raise SystemExit('missing html pattern:\n' + old[:300])
    h = h.replace(old, new, 1)

hrep('style.css?v=20260903-4', 'style.css?v=20260903-6')
hrep('app.js?v=20260903-5', 'app.js?v=20260903-6')
hrep('''          <label>g+ [deg/(mA·s)] <span class="provisional">要実機確定</span>
            <input id="gPlus" type="number" value="0.290" min="0.001" max="5" step="0.001">
          </label>
          <label>g− [deg/(mA·s)] <span class="provisional">要実機確定</span>
            <input id="gMinus" type="number" value="0.290" min="0.001" max="5" step="0.001">
          </label>
          <label>g同定Q上限 [mA·s] <span class="provisional">警告のみ・制御は切らない</span>
            <input id="qModelMaxMas" type="number" value="1.6" min="0.05" max="50" step="0.05">
          </label>''',
    '''          <label>g+ [deg/(mA·s)] <span class="provisional">動画LOO実測</span>
            <input id="gPlus" type="number" value="0.290316" min="0.001" max="5" step="0.000001">
          </label>
          <label>g− [deg/(mA·s)] <span class="provisional">動画LOO実測</span>
            <input id="gMinus" type="number" value="0.254547" min="0.001" max="5" step="0.000001">
          </label>
          <label>g同定Q下限 [mA·s] <span class="provisional">警告のみ</span>
            <input id="qModelMinMas" type="number" value="0.454" min="0" max="50" step="0.001">
          </label>
          <label>g同定Q上限 [mA·s] <span class="provisional">警告のみ</span>
            <input id="qModelMaxMas" type="number" value="1.197" min="0.05" max="50" step="0.001">
          </label>''')
hrep('''          <label>モータ kt [N·m/A] <span class="provisional">要実機確定</span><input id="kt" type="number" value="0.05" min="0.0001" max="1" step="0.001"></label>
          <label>ホイール Jw [kg·m²] <span class="provisional">要実機確定</span><input id="jw" type="number" value="0.00008" min="0.000001" max="0.01" step="0.00001"></label>
          <label>ホイール上限 [rpm]<input id="maxRpm" type="number" value="6000" min="100" max="50000" step="100"></label>''',
    '''          <label>等価モータ kt [N·m/A] <span class="provisional">実トルク整合</span><input id="kt" type="number" value="0.036" min="0.0001" max="1" step="0.001"></label>
          <label>ホイール Jw [kg·m²] <span class="provisional">形状計算</span><input id="jw" type="number" value="0.000021" min="0.000001" max="0.01" step="0.000001"></label>
          <label>ホイール実用上限 [rpm] <span class="provisional">実測目安</span><input id="maxRpm" type="number" value="1050" min="100" max="50000" step="50"></label>''')
hrep('''          <label>質量 m [kg]<input id="massKg" type="number" value="0.1997" min="0.01" max="5" step="0.0001"></label>
          <label>CG慣性 Icg [kg·m²]<input id="icg" type="number" value="0.00055" min="0.000001" max="0.1" step="0.00001"></label>
          <label>粘性 c [N·m·s/rad]<input id="viscous" type="number" value="0.00012" min="0" max="0.02" step="0.00001"></label>
          <label>クーロン摩擦 τc [N·m]<input id="coulomb" type="number" value="0.00005" min="0" max="0.01" step="0.00001"></label>''',
    '''          <label>質量 m [kg] <span class="provisional">実測</span><input id="massKg" type="number" value="0.1997" min="0.01" max="5" step="0.0001"></label>
          <label>有効ロール慣性 Ieff [kg·m²] <span class="provisional">自由減衰周期同定</span><input id="ieff" type="number" value="0.00090" min="0.000001" max="0.1" step="0.00001"></label>
          <label>等価粘性 c [N·m·s/rad] <span class="provisional">自由減衰同定</span><input id="viscous" type="number" value="0.00050" min="0" max="0.02" step="0.00001"></label>
          <label>等価クーロン摩擦 τc [N·m] <span class="provisional">未分離→0</span><input id="coulomb" type="number" value="0" min="0" max="0.01" step="0.00001"></label>''')
hrep('''        <p><strong>モデル信頼性:</strong> Qcmdがgの同定範囲を超えたら外挿として明示します。</p>''',
    '''        <p><strong>モデル信頼性:</strong> 非ゼロQの実測支持域は0.454–1.197 mA·s。下側・上側どちらの外挿も明示します。</p>''')
# Add a concise provenance note under machine parameters.
marker = '''        </div>\n      </details>\n\n      <div class="controller-explain">'''
insert = '''        </div>\n        <p class="note small">既定値は過去実測へ寄せています：m=0.1997 kg、R=0.150 m、zG=0.120 m、Ieff≈0.00090 kg·m²、c≈0.00050 N·m·s/rad、Jw≈2.1e−5 kg·m²、RW実用上限≈1050 rpm。IeffはCAD慣性ではなく自由減衰周期に合わせた等価値です。</p>\n      </details>\n\n      <div class="controller-explain">'''
if marker not in h:
    raise SystemExit('machine details marker missing')
h = h.replace(marker, insert, 1)
idx_path.write_text(h, encoding='utf-8')

print('parameter migration complete')
