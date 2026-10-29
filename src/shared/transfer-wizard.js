'use strict';

/**
 * Lógica PURA del asistente de copiar y transferir (módulo UMD: sirve con require() en las pruebas y
 * con <script> en la interfaz; sin DOM, sin Electron, sin dependencias). Aquí están las decisiones que
 * importan para no perder datos, separadas del dibujo en pantalla para poder probarlas:
 *   · qué se puede hacer en cada paso (no se avanza con impedimentos; no se borra sin confirmar;
 *     la verificación rápida no existe para transferir; tope de 500 carpetas),
 *   · qué se le pide al motor (la interfaz NUNCA manda un destino: usa «el destino elegido»),
 *   · qué botones se muestran en el resultado y qué texto lleva cada estado,
 *   · formato de bytes, tiempos y velocidad, y traducción de errores del sistema a lenguaje llano.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BYDTransferWizard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SOURCES = 500;
  const STEPS = ['destino', 'revision', 'progreso', 'resultado'];
  /** Resultados en los que el original ya no está donde estaba (o quedó a medias). */
  const ORIGINAL_GONE = ['original-enviado-a-papelera', 'original-borrado-definitivamente', 'borrado-parcial'];
  /** Motivos por los que la Papelera no retiró el original y se puede ofrecer borrarlo definitivamente. */
  const RECYCLE_FAILED_CODES = ['papelera-fallo', 'papelera-no-cabe'];

  // ---------------------------------------------------------------- formato

  const nf = (n) => (typeof Intl !== 'undefined' ? new Intl.NumberFormat('es').format(n) : String(n));

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '–';
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    const text = i === 0 ? nf(value) : (Math.round(value * 10) / 10).toLocaleString('es', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
    return `${text} ${units[i]}`;
  }

  /** 3 → «3 s», 75 → «1 min 15 s», 3700 → «1 h 1 min». Sin dato → «calculando…». */
  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 'calculando…';
    const s = Math.round(seconds);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h >= 100 ? `${nf(h)} h` : `${h} h ${m} min`;
  }

  function formatSpeed(bytesPerSecond) {
    if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return 'calculando…';
    return `${formatBytes(bytesPerSecond)}/s`;
  }

  function plural(n, uno, varios) {
    return `${nf(n)} ${n === 1 ? uno : varios}`;
  }

  /** Acorta por el medio: {shown, full}. El texto completo va en el título (tooltip). */
  function truncateMiddle(text, max = 60) {
    const full = typeof text === 'string' ? text : '';
    if (max < 5 || full.length <= max) return { shown: full, full };
    const keep = max - 1; // 1 para «…»
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    return { shown: `${full.slice(0, head)}…${full.slice(full.length - tail)}`, full };
  }

  // ------------------------------------------------- errores del sistema, en llano

  const ERROR_RULES = [
    [/\bENOSPC\b|no space left|disk full|espacio insuficiente/i, 'No hay espacio suficiente en el disco de destino.'],
    [/\bE_ABORT\b|\bFOFX\b|recycle|papelera/i, 'Windows no pudo enviar la carpeta a la Papelera (probablemente no cabe o ese disco no tiene Papelera).'],
    [/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|access is denied|acceso denegado/i, 'Windows no dio permiso para hacer eso. El archivo puede estar protegido o en uso.'],
    [/\bEBUSY\b|resource busy|being used by another|en uso|\bETXTBSY\b/i, 'El archivo o la carpeta está en uso por otro programa. Ciérralo y vuelve a intentarlo.'],
    [/\bENOENT\b|no such file|cannot find|no se encuentra|not found/i, 'No se encontró el archivo o la carpeta (¿se movió o se borró mientras tanto?).'],
    [/\bEIO\b|\bENODEV\b|\bENXIO\b|\bENOTCONN\b|\bESHUTDOWN\b|input\/output|i\/o error|\bE\/S\b|device not|se desconect/i, 'El disco se desconectó o dejó de responder. Los originales no se tocaron. Vuelve a conectarlo y revisa si quedó una carpeta «….copiando» para borrarla.'],
    [/\bEROFS\b|read-only|solo lectura/i, 'El disco es de solo lectura: no se puede escribir en él.'],
    [/\bEEXIST\b|already exists|ya exist/i, 'Ya existe algo con ese nombre en el destino. BoneYardDog nunca sobrescribe.'],
    [/\bENAMETOOLONG\b|name too long|path too long|ruta.*larga/i, 'La ruta es demasiado larga para Windows.'],
    [/\bEMFILE\b|\bENFILE\b|too many open files/i, 'Windows tiene demasiados archivos abiertos a la vez. Espera un momento y vuelve a intentarlo.'],
    [/\bENOTEMPTY\b|directory not empty/i, 'La carpeta no está vacía.'],
    [/\bEXDEV\b|cross-device/i, 'No se puede hacer eso entre dos discos distintos.'],
    [/\bEINVAL\b|invalid argument/i, 'Windows rechazó el nombre o la ruta como no válidos.'],
    [/\bOCUPADO\b|ya hay una transferencia/i, 'Ya hay una copia o una verificación en curso. Espera a que termine.'],
    [/Remitente no autorizado/i, 'La acción fue rechazada por seguridad.'],
    [/Plan desconocido|\bPLAN_DESCONOCIDO\b/i, 'La revisión previa ya no es válida. Vuelve a revisar antes de empezar.'],
    [/Resultado desconocido|\bRESULTADO_DESCONOCIDO\b/i, 'Ese resultado ya no está disponible en esta sesión.'],
    [/\bRUTA_DESCONOCIDA\b|no est[aá] en el [aá]rbol/i, 'Esa carpeta ya no forma parte del análisis. Vuelve a escanear.'],
    [/\bMANIFIESTO\b/i, 'Esa carpeta no es una copia de BoneYardDog (no tiene MANIFIESTO.json).'],
  ];

  /** Traduce un mensaje técnico a lenguaje llano. Lo desconocido se dice como tal, sin inventar. */
  function translateError(message) {
    const raw = message instanceof Error ? message.message : typeof message === 'string' ? message : message == null ? '' : String(message);
    for (const [pattern, text] of ERROR_RULES) if (pattern.test(raw)) return text;
    return raw ? `Ocurrió un problema inesperado: ${raw}` : 'Ocurrió un problema inesperado.';
  }

  // ----------------------------------------------- impedimentos: qué hacer

  const BLOCKER_ADVICE = {
    'modo-invalido': 'Cierra el asistente y vuelve a empezar.',
    'verificacion-invalida': 'Elige «Completa» o «Rápida».',
    'disposicion-invalida': 'Vuelve al paso anterior y elige qué hacer con el original.',
    'mover-requiere-verificacion-completa': 'Elige la verificación completa: para retirar el original hay que comparar el contenido.',
    'borrado-sin-confirmar': 'Marca «Entiendo que no se podrá recuperar» o elige dejar el original.',
    'sin-origenes': 'Selecciona al menos una carpeta.',
    'demasiados-origenes': `Selecciona ${MAX_SOURCES} carpetas o menos.`,
    'destino-no-valido': 'Elige otro destino.',
    'destino-red': 'Elige una unidad con letra (un USB o un disco externo), no una carpeta de red.',
    'destino-protegido': 'Elige otro destino: esa carpeta es del sistema.',
    'destino-dentro-del-origen': 'Elige un destino fuera de la carpeta que quieres copiar.',
    'destino-no-existe': 'Conecta el disco de destino (o elige otro) y vuelve a revisar.',
    'destino-no-es-carpeta': 'Elige una carpeta como destino.',
    'destino-no-escribible': 'Elige otro destino, o comprueba que el disco no esté protegido contra escritura.',
    'origen-no-valido': 'Vuelve a seleccionar las carpetas.',
    'origen-protegido': 'Quita esa carpeta de la selección: es del sistema.',
    'origen-anidado': 'Quita la carpeta interior: ya está incluida dentro de la otra.',
    'origen-no-existe': 'Esa carpeta ya no existe. Quítala de la selección o vuelve a escanear.',
    'origen-es-enlace': 'Quita ese acceso directo de la selección.',
    'origen-no-es-carpeta': 'Quita ese elemento de la selección: solo se copian carpetas.',
    'origen-contiene-protegidos': 'Quita esa carpeta de la selección: tiene elementos del sistema dentro.',
    'archivo-demasiado-grande': 'Elige un destino con formato exFAT o NTFS. Reformatear un disco borra todo lo que tenga.',
    'nombres-no-validos': 'Cambia el nombre de lo indicado (en el origen) o elige un destino con otro formato.',
    'sin-espacio': 'Libera espacio en el destino, elige otro disco o copia menos carpetas.',
    'sin-funcion-papelera': 'Elige dejar el original o borrarlo definitivamente.',
  };

  function blockerAdvice(code) {
    return BLOCKER_ADVICE[code] || 'Corrige eso y vuelve a revisar.';
  }

  // ----------------------------------------------------------- selección

  /** ¿Cuántas de las `incoming` caben sin pasar de 500? Devuelve las que se aceptan y las que sobran. */
  function limitSelection(currentCount, incoming) {
    const room = Math.max(0, MAX_SOURCES - currentCount);
    return { accepted: incoming.slice(0, room), rejected: incoming.slice(room) };
  }

  // ------------------------------------------------------- verificación

  /** Opciones de verificación y si cada una está disponible. La rápida NO existe al transferir. */
  function verifyOptions(mode) {
    return [
      { id: 'full', label: 'Completa (recomendada)', detail: 'Compara el contenido de cada archivo (huella SHA-256). Es más lenta.', available: true },
      {
        id: 'quick',
        label: 'Rápida (solo tamaño y fecha; no comprueba el contenido)',
        detail: mode === 'move' ? 'No disponible al transferir: para retirar el original hace falta comparar el contenido.' : 'Más rápida, pero un archivo dañado podría pasar sin detectarse.',
        available: mode !== 'move',
      },
    ];
  }

  /** La verificación que realmente se usa (transferir siempre es completa). */
  function effectiveVerify(mode, verify) {
    if (mode === 'move') return 'full';
    return verify === 'quick' ? 'quick' : 'full';
  }

  // --------------------------------------------------- petición al motor

  /**
   * Lo que se le pide al motor para revisar. NUNCA lleva destino: el proceso principal usa el elegido.
   * @param {{mode: 'copy'|'move', verify?: string, sources: string[], recycleChoice?: 'borrar'|'dejar'|null, understood?: boolean}} s
   */
  function buildPreflightRequest(s) {
    const sources = Array.isArray(s.sources) ? s.sources.slice(0, MAX_SOURCES) : [];
    if (s.mode === 'move') {
      if (s.recycleChoice === 'dejar') return { mode: 'copy', verify: 'full', disposal: 'ninguna', confirmPermanentDelete: false, sources };
      if (s.recycleChoice === 'borrar') return { mode: 'move', verify: 'full', disposal: 'borrar', confirmPermanentDelete: s.understood === true, sources };
      return { mode: 'move', verify: 'full', disposal: 'papelera', confirmPermanentDelete: false, sources };
    }
    return { mode: 'copy', verify: effectiveVerify('copy', s.verify), disposal: 'ninguna', confirmPermanentDelete: false, sources };
  }

  // -------------------------------------------------------- la revisión

  const hasWarning = (review, code) => Boolean(review && Array.isArray(review.warnings) && review.warnings.some((w) => w.code === code));

  /** ¿Hay que preguntar qué hacer porque probablemente no cabe en la Papelera? Solo al transferir. */
  function needsRecycleChoice(mode, review) {
    return mode === 'move' && hasWarning(review, 'papelera-no-cabe');
  }

  /** Impedimentos de la revisión (nada que continuar mientras haya alguno). */
  function blockersOf(review) {
    return review && Array.isArray(review.blockers) ? review.blockers : [];
  }

  /**
   * ¿Se puede pulsar «Empezar» en el paso 2?
   *   · hay una revisión sin impedimentos y con plan;
   *   · si hay que elegir qué hacer por la Papelera, se eligió (nada preseleccionado);
   *   · si se eligió borrar definitivamente, se marcó «Entiendo que no se podrá recuperar».
   * @returns {{ok: boolean, reason: string|null}}
   */
  function canStart(state) {
    const review = state && state.review;
    if (!review) return { ok: false, reason: 'Todavía no se revisó nada.' };
    if (blockersOf(review).length > 0) return { ok: false, reason: 'Hay impedimentos: corrígelos para continuar.' };
    if (!review.planId) return { ok: false, reason: 'La revisión no produjo un plan.' };
    if (needsRecycleChoice(state.mode, review)) {
      if (state.recycleChoice !== 'borrar' && state.recycleChoice !== 'dejar') return { ok: false, reason: 'Elige qué hacer con el original.' };
      if (state.recycleChoice === 'borrar' && state.understood !== true) return { ok: false, reason: 'Marca «Entiendo que no se podrá recuperar» para borrar definitivamente.' };
    }
    if (state.mode === 'move' && state.recycleChoice === 'borrar' && state.understood !== true) return { ok: false, reason: 'Marca «Entiendo que no se podrá recuperar» para borrar definitivamente.' };
    return { ok: true, reason: null };
  }

  /** ¿Se puede pasar del paso 1 al 2? */
  function canGoToReview(state) {
    if (!state || !state.destination) return { ok: false, reason: 'Elige primero el destino.' };
    const n = Array.isArray(state.sources) ? state.sources.length : 0;
    if (n < 1) return { ok: false, reason: 'No hay carpetas seleccionadas.' };
    if (n > MAX_SOURCES) return { ok: false, reason: `Máximo ${MAX_SOURCES} carpetas por operación.` };
    if (state.mode === 'move' && state.verify === 'quick') return { ok: false, reason: 'Transferir exige la verificación completa.' };
    return { ok: true, reason: null };
  }

  /** Texto del bloque de confirmación en rojo: cuántas carpetas y cuántos bytes se borrarían sin Papelera. */
  function deleteConfirmationText(folders, bytes) {
    return `Se borrarán definitivamente ${plural(folders, 'carpeta', 'carpetas')} (${formatBytes(bytes)}) sin pasar por la Papelera. No se podrá recuperar. Solo ocurre después de verificar la copia por completo.`;
  }

  /** ¿Se puede cerrar el diálogo? No a medias: solo con Cancelar (o cuando ya terminó). */
  function canClose(state) {
    return !(state && state.running === true);
  }

  // ----------------------------------------------------------- progreso

  const PHASES = {
    preparando: 'Preparando',
    planificando: 'Preparando',
    copiando: 'Copiando',
    verificando: 'Verificando',
    'retirando original': 'Retirando el original',
    terminado: 'Terminando',
  };

  function phaseLabel(fase) {
    return PHASES[fase] || 'Trabajando';
  }

  /** Porcentaje 0–100 del avance total. La verificación completa recorre los bytes dos veces (copiar + verificar). */
  function progressPercent(ev, verify) {
    if (!ev || typeof ev !== 'object') return 0;
    if (ev.fase === 'terminado') return 100;
    const passes = verify === 'quick' ? 1 : 2;
    const total = Number(ev.totalBytes) * passes;
    if (Number.isFinite(total) && total > 0) {
      const done = Number(ev.overallBytesDone);
      return Math.max(0, Math.min(99, Math.floor((done / total) * 100)));
    }
    const files = Number(ev.totalFiles);
    if (Number.isFinite(files) && files > 0) return Math.max(0, Math.min(99, Math.floor((Number(ev.overallFilesDone) / files) * 100)));
    return 0;
  }

  /** Todo lo que muestra el paso 3, calculado del evento del motor. */
  function progressView(ev, verify) {
    const e = ev && typeof ev === 'object' ? ev : {};
    const file = truncateMiddle(e.archivo || '', 60);
    return {
      phase: phaseLabel(e.fase),
      percent: progressPercent(e, verify),
      bytesText: `${formatBytes(e.overallBytesDone)} de ${formatBytes(e.totalBytes)}`,
      // Textos separados (mismas unidades en todos: 1 GB = 1024 MB, como en el Explorador de Windows).
      copiedText: `Copiado ${formatBytes(e.copiadoBytes || 0)} de ${formatBytes(e.totalBytes)}`,
      verifiedText: Number.isFinite(e.totalVerificarBytes) && e.totalVerificarBytes > 0 ? `Verificado ${formatBytes(e.verificadoBytes || 0)} de ${formatBytes(e.totalVerificarBytes)}` : 'Verificación rápida (tamaño y fecha)',
      stageText: e.etapa ? `Etapa: ${e.etapa}` : '',
      filesText: `${nf(e.overallFilesDone || 0)} de ${nf(e.totalFiles || 0)} archivos`,
      currentFile: file.shown,
      currentFileFull: file.full,
      speedText: formatSpeed(e.bytesPerSecond),
      etaText: formatDuration(e.etaSeconds),
    };
  }

  // ----------------------------------------------------------- resultado

  /** Estado de cada carpeta: icono (con texto, nunca solo color), tono y explicación en llano. */
  function folderStatus(c) {
    const motivo = c && c.motivo ? c.motivo : '';
    switch (c && c.resultado) {
      case 'copiada-verificada':
        return { icon: '✔', tone: 'ok', label: 'Copiada y verificada', detail: 'El original se quedó donde estaba.' };
      case 'original-enviado-a-papelera':
        return { icon: '✔', tone: 'ok', label: 'Copiada y verificada · original enviado a la Papelera', detail: 'Puedes recuperar el original desde la Papelera de Windows mientras no la vacíes.' };
      case 'original-borrado-definitivamente':
        return { icon: '✔', tone: 'ok', label: 'Copiada y verificada · original borrado definitivamente', detail: 'El original ya no existe; la copia verificada es lo único que queda.' };
      case 'borrado-parcial':
        return { icon: '✖', tone: 'error', label: 'Borrado a medias', detail: motivo || 'El borrado del original se detuvo a medias. La copia está completa; revisa qué quedó en el origen.' };
      case 'original-sin-tocar':
        return { icon: '●', tone: 'aviso', label: 'Copiada y verificada · original sin tocar', detail: explainKept(c) };
      case 'con-errores':
        return { icon: '✖', tone: 'error', label: 'Con errores', detail: motivo || 'No se pudo copiar o verificar todo. El original no se tocó.' };
      case 'cancelada':
        return { icon: '⏹', tone: 'aviso', label: 'Cancelada', detail: motivo || 'Cancelada. Los originales no se tocaron.' };
      default:
        return { icon: '?', tone: 'aviso', label: 'Estado desconocido', detail: motivo };
    }
  }

  /** Por qué el original quedó sin tocar, en lenguaje llano. */
  function explainKept(c) {
    const motivo = c && c.motivo ? c.motivo : '';
    switch (c && c.motivoCodigo) {
      case 'papelera-fallo':
        return `No se pudo enviar a la Papelera, así que el original sigue en su sitio${c.errorPapelera ? ` (${translateError(c.errorPapelera)})` : ''}.`;
      case 'papelera-no-cabe':
        return 'Lo más probable es que no quepa en la Papelera, así que el original sigue en su sitio.';
      case 'sin-confirmacion':
        return 'Faltaba la confirmación del borrado definitivo, así que el original sigue en su sitio.';
      case 'origen-cambio':
        return 'El original cambió mientras se copiaba (o después), así que se dejó donde estaba para no perder cambios.';
      case 'copia-incompleta':
        return 'La copia ya no está completa en el destino, así que el original se dejó donde estaba.';
      case 'con-enlaces':
        return 'Tiene accesos directos (enlaces) o elementos que no se copiaron, así que el original se dejó donde estaba.';
      case 'protegida':
        return 'Es una carpeta protegida del sistema, así que el original se dejó donde estaba.';
      case 'copia-no-verificada':
        return 'La copia no quedó verificada por completo, así que el original se dejó donde estaba.';
      default:
        if (/Pedido: dejar el original/.test(motivo)) return 'Elegiste dejar el original donde estaba.';
        return motivo || 'El original se quedó donde estaba.';
    }
  }

  function countBy(result, predicate) {
    return (result && Array.isArray(result.carpetas) ? result.carpetas : []).filter(predicate).length;
  }

  /**
   * Titular del resultado. Devuelve null si todavía no hay resultado del motor: NUNCA se muestra «Listo»
   * sin haber visto el resultado.
   */
  function resultHeadline(result) {
    if (!result || !Array.isArray(result.carpetas)) return null;
    const total = result.carpetas.length;
    const bad = countBy(result, (c) => c.resultado === 'con-errores' || c.resultado === 'borrado-parcial');
    const cancelled = result.estado === 'cancelado' || countBy(result, (c) => c.resultado === 'cancelada') === total;
    const verified = countBy(result, (c) => c.verificada === true);
    if (result.forzada) return { tone: 'error', text: result.aviso || 'Cancelada a la fuerza porque el disco no respondía. Los originales no se tocaron.' };
    if (result.abortada) return { tone: 'error', text: `La operación se detuvo: ${translateError(result.abortada.message || result.abortada.code)}` };
    if (cancelled) {
      const left = result.carpetas.flatMap((c) => (c.limpieza && !c.limpieza.limpia ? c.limpieza.pendientes : []));
      return { tone: 'aviso', text: left.length ? `Cancelada. Los originales no se tocaron, pero quedó una copia incompleta que no se pudo quitar: ${left.join('; ')}. Bórrala tú.` : 'Cancelada. Se quitó la copia incompleta. Los originales no se tocaron.' };
    }
    if (bad > 0) return { tone: 'error', text: `Terminó con problemas en ${plural(bad, 'carpeta', 'carpetas')} de ${nf(total)}. Revisa el detalle.` };
    if (verified === total) return { tone: 'ok', text: `Listo: ${plural(total, 'carpeta copiada y verificada', 'carpetas copiadas y verificadas')}.` };
    return { tone: 'aviso', text: `Terminó, pero solo ${nf(verified)} de ${plural(total, 'carpeta', 'carpetas')} quedó verificada.` };
  }

  /** ¿Hay carpetas cuyo original ya no está (o quedó a medias)? Entonces la copia es lo único que queda. */
  function anyOriginalGone(result) {
    return countBy(result, (c) => ORIGINAL_GONE.includes(c.resultado)) > 0;
  }

  /** Posiciones de las carpetas a las que se les puede ofrecer el borrado definitivo (Papelera fallida). */
  function deletableIndices(result) {
    const out = [];
    (result && Array.isArray(result.carpetas) ? result.carpetas : []).forEach((c, i) => {
      if (c.resultado === 'original-sin-tocar' && RECYCLE_FAILED_CODES.includes(c.motivoCodigo) && c.verificada === true) out.push(i);
    });
    return out;
  }

  /** Cuántas carpetas y cuántos bytes se borrarían con esas posiciones (a partir del resumen del plan). */
  function deleteTotals(result, indices, plannedBytesByIndex) {
    let bytes = 0;
    for (const i of indices) bytes += Number(plannedBytesByIndex && plannedBytesByIndex[i]) || 0;
    return { folders: indices.length, bytes };
  }

  /** Carpeta que «Abrir la copia en el Explorador» muestra: la primera copia terminada (o la provisional que quedó). */
  function revealTarget(result) {
    const list = result && Array.isArray(result.carpetas) ? result.carpetas : [];
    const done = list.find((c) => c.verificada === true && typeof c.destino === 'string');
    if (done) return done.destino;
    const left = list.find((c) => c.limpieza && !c.limpieza.limpia && c.limpieza.pendientes && c.limpieza.pendientes[0]);
    return left ? left.limpieza.pendientes[0] : null;
  }

  /**
   * Qué botones se muestran en el resultado.
   *  · abrir: si hay una copia terminada (o una provisional que quedó);
   *  · verificar de nuevo: si alguna copia tiene registro;
   *  · quitar la copia: SOLO tras una copia COMPLETA (copiar), nunca tras cancelar (la app ya limpió sola) y nunca si algún
   *    original se retiró (la copia es lo único que queda);
   *  · borrar definitivamente: SOLO si la Papelera falló en alguna carpeta.
   */
  function resultButtons(result) {
    if (!result || !Array.isArray(result.carpetas)) {
      return { openCopy: false, verifyAgain: false, removeCopy: false, deleteAfterRecycleFail: false, needsRescan: false };
    }
    const list = result.carpetas;
    return {
      openCopy: revealTarget(result) !== null,
      verifyAgain: list.some((c) => c.verificada === true && typeof c.registroId === 'string'),
      removeCopy: result.estado !== 'cancelado' && !anyOriginalGone(result) && list.some((c) => c.verificada === true && c.resultado === 'copiada-verificada'),
      deleteAfterRecycleFail: deletableIndices(result).length > 0,
      needsRescan: anyOriginalGone(result),
    };
  }

  /** Rutas de origen que desaparecieron de su sitio (para quitarlas de las vistas). */
  function removedSources(result) {
    const out = [];
    for (const c of result && Array.isArray(result.carpetas) ? result.carpetas : []) {
      if (c.resultado === 'original-enviado-a-papelera' || c.resultado === 'original-borrado-definitivamente') {
        out.push(c.solicitado || c.origen);
        if (c.origen && c.origen !== (c.solicitado || c.origen)) out.push(c.origen);
      }
    }
    return out;
  }

  /** Resultado de «verificar de nuevo»: titular y lista de problemas en llano. */
  const PROBLEM_TEXT = {
    falta: 'falta',
    tamano: 'tiene otro tamaño',
    huella: 'el contenido no coincide (archivo alterado)',
    fecha: 'tiene otra fecha',
    sobrante: 'sobra: no estaba en la copia original',
    'no-es-archivo': 'ya no es un archivo',
    'ruta-no-valida': 'ruta no válida en el manifiesto',
    'sin-huella-en-el-manifiesto': 'el registro no trae huella (se comparó solo tamaño)',
    'sin-huella-en-el-registro': 'el registro no trae huella (se comparó solo tamaño)',
    ilegible: 'no se pudo leer',
  };

  /** Texto en llano de un problema de verificación. */
  function problemText(p) {
    return PROBLEM_TEXT[p.problema] || translateError(String(p.problema).replace(/^error-/, ''));
  }

  function verifyView(res) {
    if (!res || typeof res !== 'object') return null;
    const name = res.nombre ? `«${res.nombre}»: ` : '';
    if (res.estado === 'no-disponible') return { ok: false, estado: res.estado, tone: 'aviso', headline: `${name}${res.motivo || 'No encuentro esa carpeta.'}`, counts: {}, lines: [], hidden: 0 };
    if (res.estado === 'distinta') return { ok: false, estado: res.estado, tone: 'error', headline: `${name}${res.motivo || 'Esa carpeta ya no es la que se copió.'}`, counts: {}, lines: [], hidden: 0 };
    if (res.estado === 'sin-archivos' || (res.estado === undefined && res.verificados === 0 && res.ok !== false)) {
      return { ok: false, estado: 'sin-archivos', tone: 'aviso', headline: `${name}No había archivos que comprobar.`, counts: {}, lines: [], hidden: 0 };
    }
    const problems = (Array.isArray(res.problemas) ? res.problemas : []).filter((p) => !p.aviso);
    const counts = {};
    for (const p of problems) counts[p.problema] = (counts[p.problema] || 0) + 1;
    const lines = problems.slice(0, 50).map((p) => ({ ruta: p.ruta, texto: PROBLEM_TEXT[p.problema] || translateError(String(p.problema).replace(/^error-/, '')) }));
    const good = res.estado === 'ok' || (res.estado === undefined && res.ok === true);
    if (good && problems.length === 0) {
      return { ok: true, estado: 'ok', tone: 'ok', headline: `${name}La copia está bien: ${plural(res.verificados, 'archivo verificado', 'archivos verificados')} (${res.modo === 'quick' ? 'solo tamaño y fecha' : 'contenido comparado'}).`, counts, lines, hidden: 0 };
    }
    return {
      ok: false,
      estado: 'problemas',
      tone: 'error',
      headline: `${name}La copia tiene ${plural(problems.length, 'problema', 'problemas')}.`,
      counts,
      lines,
      hidden: Math.max(0, problems.length - lines.length),
    };
  }

  // ------------------------------------------------------- estado del asistente (todo lo que se ve sale de aquí)

  const IDLE_NOTICE = 'Si cancelas, los originales no se tocan.';
  const CANCEL_NOTICE = 'Cancelando… Los originales no se tocan.';
  const STALL_SECONDS = 15;

  /**
   * Estado NUEVO del asistente. Se crea cada vez que se abre el diálogo: NADA sobrevive de una operación anterior (ni el
   * aviso de «Cancelando…», ni botones deshabilitados, ni la barra, ni el resultado, ni las elecciones, ni las
   * confirmaciones de borrado, ni los mensajes de error).
   * @param {'transfer'|'copies'} kind
   * @param {'copy'|'move'} mode
   * @param {Array<{path: string, name: string}>} items
   */
  function newWizard(kind = 'transfer', mode = 'copy', items = []) {
    return {
      kind,
      mode,
      verify: 'full',
      items: items.slice(0, MAX_SOURCES),
      step: kind === 'copies' ? 'copias' : 'destino',
      destination: null,
      review: null,
      recycleChoice: null,
      understood: false,
      phase: 'idle', // idle | running | cancelling
      progress: null,
      error: '',
      result: null,
      runId: null,
      resultConfirm: false, // la casilla «Entiendo…» de la pantalla de resultado
      removeConfirmOpen: false,
    };
  }

  /**
   * Cambios de estado. Pura: devuelve un estado nuevo. Al EMPEZAR una operación se reinicia todo lo que es de una operación
   * (progreso, «Cancelando…», error, resultado, confirmación de borrado de resultado): una operación nueva parte de cero.
   */
  function reduce(state, action) {
    switch (action && action.type) {
      case 'set-destination':
        return { ...state, destination: action.destination, review: null, recycleChoice: null, understood: false, error: '' };
      case 'set-verify':
        return { ...state, verify: action.verify };
      case 'step':
        return { ...state, step: action.step };
      case 'review':
        return { ...state, review: action.review };
      case 'recycle-choice':
        return { ...state, recycleChoice: action.choice, understood: action.choice === 'borrar' ? state.understood : false };
      case 'understood':
        return { ...state, understood: action.value === true };
      case 'start-operation':
        return { ...state, phase: 'running', progress: null, error: '', result: null, runId: null, resultConfirm: false, removeConfirmOpen: false, step: 'progreso' };
      case 'progress':
        return state.phase === 'running' || state.phase === 'cancelling' ? { ...state, progress: { ...action.event, receivedAt: action.now || 0 } } : state;
      case 'cancel':
        return state.phase === 'running' ? { ...state, phase: 'cancelling' } : state;
      case 'finished':
        // La operación terminó: no queda ninguna elección ni confirmación que pueda valer para la siguiente.
        return { ...state, phase: 'idle', result: action.result, runId: action.result ? action.result.runId : null, step: 'resultado', recycleChoice: null, understood: false, resultConfirm: false };
      case 'failed':
        return { ...state, phase: 'idle', error: action.error || '', step: action.step || state.step };
      case 'result-confirm':
        return { ...state, resultConfirm: action.value === true };
      case 'error':
        return { ...state, error: action.text || '' };
      default:
        return state;
    }
  }

  /**
   * Lo que se muestra, calculado del estado. `now` (ms) sirve para el aviso de «tardando».
   * El aviso de «Cancelando…» SOLO sale si el estado está cancelando.
   */
  function wizardView(state, now = 0) {
    const cancelling = state.phase === 'cancelling';
    const running = state.phase === 'running' || cancelling;
    const prog = progressView(state.progress, state.mode === 'move' ? 'full' : state.verify);
    const stalled = running && state.progress && Number.isFinite(state.progress.sinAvanceSegundos) && state.progress.sinAvanceSegundos >= STALL_SECONDS;
    return {
      title: state.kind === 'copies' ? 'Copias anteriores' : state.mode === 'move' ? 'Transferir a otro disco (mover)' : 'Copiar a otro disco',
      notice: cancelling ? CANCEL_NOTICE : IDLE_NOTICE,
      cancelDisabled: cancelling,
      cancelVisible: running,
      progress: state.progress ? prog : progressView(null, state.verify),
      stalledNotice: stalled ? `El disco o el antivirus está tardando… (etapa: ${state.progress.etapa || state.progress.fase || 'trabajando'}, hace ${Math.floor(state.progress.sinAvanceSegundos)} s)` : '',
      errorText: state.error,
      showResult: state.step === 'resultado' && Boolean(state.result),
      resultConfirm: state.resultConfirm,
      recycleChoice: state.recycleChoice,
      understood: state.understood,
      now,
    };
  }

  return {
    newWizard,
    reduce,
    wizardView,
    STALL_SECONDS,
    CANCEL_NOTICE,
    IDLE_NOTICE,
    MAX_SOURCES,
    STEPS,
    ORIGINAL_GONE,
    RECYCLE_FAILED_CODES,
    formatBytes,
    formatDuration,
    formatSpeed,
    plural,
    truncateMiddle,
    translateError,
    blockerAdvice,
    limitSelection,
    verifyOptions,
    effectiveVerify,
    buildPreflightRequest,
    needsRecycleChoice,
    blockersOf,
    canStart,
    canGoToReview,
    canClose,
    deleteConfirmationText,
    phaseLabel,
    progressPercent,
    progressView,
    folderStatus,
    explainKept,
    resultHeadline,
    anyOriginalGone,
    deletableIndices,
    deleteTotals,
    resultButtons,
    revealTarget,
    removedSources,
    verifyView,
    problemText,
  };
});
