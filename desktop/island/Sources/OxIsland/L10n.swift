import Foundation

/// The island in ten languages (Coucou has ten): English, Español, Français,
/// Deutsch, Português, Italiano, 日本語, 한국어, 简体中文, हिन्दी. It follows the
/// Mac's language, or the one you pick:  defaults write dev.ox.island island.language fr
/// A string with no translation shows in English.
enum L10n {
    static let languages = ["en", "es", "fr", "de", "pt", "it", "ja", "ko", "zh", "hi"]
    static var lang: String = {
        if let pick = UserDefaults.standard.string(forKey: "island.language"), languages.contains(pick) { return pick }
        for pref in Locale.preferredLanguages {
            let code = String(pref.prefix(2))
            if languages.contains(code) { return code }
        }
        return "en"
    }()

    // [English: [es, fr, de, pt, it, ja, ko, zh, hi]]
    static let table: [String: [String]] = [
        "All quiet": ["Todo tranquilo", "Tout est calme", "Alles ruhig", "Tudo tranquilo", "Tutto tranquillo", "静かです", "조용해요", "一切安静", "सब शांत है"],
        "Nothing running": ["Nada en marcha", "Rien en cours", "Nichts läuft", "Nada em execução", "Niente in corso", "実行中のものはありません", "실행 중인 작업 없음", "没有正在运行的任务", "कुछ नहीं चल रहा"],
        "No other sessions": ["No hay otras sesiones", "Aucune autre session", "Keine anderen Sitzungen", "Nenhuma outra sessão", "Nessun'altra sessione", "他のセッションはありません", "다른 세션 없음", "没有其他会话", "कोई और सत्र नहीं"],
        "Allow": ["Permitir", "Autoriser", "Erlauben", "Permitir", "Consenti", "許可", "허용", "允许", "अनुमति दें"],
        "Always": ["Siempre", "Toujours", "Immer", "Sempre", "Sempre", "常に", "항상", "始终", "हमेशा"],
        "Always allow": ["Permitir siempre", "Toujours autoriser", "Immer erlauben", "Permitir sempre", "Consenti sempre", "常に許可", "항상 허용", "始终允许", "हमेशा अनुमति दें"],
        "Deny": ["Denegar", "Refuser", "Ablehnen", "Negar", "Nega", "拒否", "거부", "拒绝", "मना करें"],
        "Approve hire": ["Aprobar contratación", "Approuver l'embauche", "Einstellung genehmigen", "Aprovar contratação", "Approva assunzione", "採用を承認", "채용 승인", "批准聘用", "नियुक्ति स्वीकारें"],
        "Reject": ["Rechazar", "Rejeter", "Ablehnen", "Rejeitar", "Rifiuta", "却下", "거절", "拒绝", "अस्वीकार करें"],
        "Back": ["Atrás", "Retour", "Zurück", "Voltar", "Indietro", "戻る", "뒤로", "返回", "वापस"],
        "Close": ["Cerrar", "Fermer", "Schließen", "Fechar", "Chiudi", "閉じる", "닫기", "关闭", "बंद करें"],
        "Go to Terminal": ["Ir a la Terminal", "Aller au Terminal", "Zum Terminal", "Ir para o Terminal", "Vai al Terminale", "ターミナルへ", "터미널로 이동", "前往终端", "टर्मिनल पर जाएँ"],
        "Pause": ["Pausar", "Pause", "Pausieren", "Pausar", "Pausa", "一時停止", "일시정지", "暂停", "रोकें"],
        "Resume": ["Reanudar", "Reprendre", "Fortsetzen", "Retomar", "Riprendi", "再開", "재개", "继续", "फिर शुरू करें"],
        "Wake now": ["Despertar ahora", "Réveiller", "Jetzt wecken", "Acordar agora", "Sveglia ora", "今すぐ起こす", "지금 깨우기", "立即唤醒", "अभी जगाएँ"],
        "Reset": ["Restablecer", "Réinitialiser", "Zurücksetzen", "Redefinir", "Reimposta", "リセット", "재설정", "重置", "रीसेट करें"],
        "Email": ["Correo", "E-mail", "E-Mail", "E-mail", "Email", "メール", "이메일", "邮件", "ईमेल"],
        "Draft in Mail": ["Borrador en Mail", "Brouillon dans Mail", "Entwurf in Mail", "Rascunho no Mail", "Bozza in Mail", "メールで下書き", "메일에 초안 작성", "在邮件中起草", "Mail में ड्राफ़्ट"],
        "Answer in terminal": ["Responder en la terminal", "Répondre dans le terminal", "Im Terminal antworten", "Responder no terminal", "Rispondi nel terminale", "ターミナルで答える", "터미널에서 답하기", "在终端中回答", "टर्मिनल में जवाब दें"],
        "Type your answer": ["Escribe tu respuesta", "Tapez votre réponse", "Antwort eingeben", "Digite sua resposta", "Scrivi la tua risposta", "回答を入力", "답변 입력", "输入你的回答", "अपना जवाब लिखें"],
        "Message ox…": ["Escribe a ox…", "Écrire à ox…", "Nachricht an ox…", "Mensagem para ox…", "Scrivi a ox…", "ox にメッセージ…", "ox에게 메시지…", "给 ox 发消息…", "ox को संदेश…"],
        "Listening…": ["Escuchando…", "J'écoute…", "Ich höre zu…", "Ouvindo…", "In ascolto…", "聞いています…", "듣고 있어요…", "正在聆听…", "सुन रहा हूँ…"],
        "Done: paste it": ["Listo: pegar", "Terminé : coller", "Fertig: einfügen", "Pronto: colar", "Fatto: incolla", "完了：貼り付け", "완료: 붙여넣기", "完成：粘贴", "हो गया: पेस्ट करें"],
        "Cancel (Esc)": ["Cancelar (Esc)", "Annuler (Échap)", "Abbrechen (Esc)", "Cancelar (Esc)", "Annulla (Esc)", "キャンセル (Esc)", "취소 (Esc)", "取消 (Esc)", "रद्द करें (Esc)"],
        "Reply": ["Responder", "Répondre", "Antworten", "Responder", "Rispondi", "返信", "답장", "回复", "जवाब दें"],
        "Mark as read": ["Marcar como leído", "Marquer comme lu", "Als gelesen markieren", "Marcar como lido", "Segna come letto", "既読にする", "읽음으로 표시", "标为已读", "पढ़ा हुआ चिह्नित करें"],
        "Open in Mail": ["Abrir en Mail", "Ouvrir dans Mail", "In Mail öffnen", "Abrir no Mail", "Apri in Mail", "メールで開く", "메일에서 열기", "在邮件中打开", "Mail में खोलें"],
        "Refresh": ["Actualizar", "Actualiser", "Aktualisieren", "Atualizar", "Aggiorna", "更新", "새로고침", "刷新", "रीफ़्रेश करें"],
        "Next": ["Siguiente", "Suivant", "Weiter", "Próximo", "Avanti", "次へ", "다음", "下一个", "अगला"],
        "Stop": ["Detener", "Arrêter", "Stopp", "Parar", "Ferma", "停止", "중지", "停止", "रोकें"],
        "Next track": ["Siguiente canción", "Morceau suivant", "Nächster Titel", "Próxima faixa", "Brano successivo", "次の曲", "다음 곡", "下一首", "अगला गाना"],
        "Clear": ["Borrar", "Effacer", "Leeren", "Limpar", "Cancella", "消去", "지우기", "清除", "साफ़ करें"],
        "Office": ["Oficina", "Bureau", "Büro", "Escritório", "Ufficio", "オフィス", "사무실", "办公室", "दफ़्तर"],
        "Turn off OX Island": ["Apagar OX Island", "Désactiver OX Island", "OX Island ausschalten", "Desligar OX Island", "Disattiva OX Island", "OX Island をオフ", "OX Island 끄기", "关闭 OX Island", "OX Island बंद करें"],
        "Drop files on the notch": ["Suelta archivos en el notch", "Déposez des fichiers sur l'encoche", "Dateien auf die Notch ziehen", "Solte arquivos no notch", "Trascina i file sul notch", "ノッチにファイルをドロップ", "노치에 파일을 놓으세요", "把文件拖到刘海上", "फ़ाइलें नॉच पर छोड़ें"],
        "Nothing copied yet": ["Aún no has copiado nada", "Rien de copié pour l'instant", "Noch nichts kopiert", "Nada copiado ainda", "Ancora niente di copiato", "まだ何もコピーしていません", "아직 복사한 항목 없음", "还没有复制内容", "अभी कुछ कॉपी नहीं हुआ"],
        "Drag me onto a window to show it to me": ["Arrástrame a una ventana para enseñármela", "Glissez-moi sur une fenêtre pour me la montrer", "Zieh mich auf ein Fenster, um es mir zu zeigen", "Arraste-me para uma janela para me mostrar", "Trascinami su una finestra per mostrarmela", "ウィンドウにドラッグして見せてください", "창 위로 끌어다 놓아 보여 주세요", "把我拖到窗口上给我看", "मुझे किसी विंडो पर खींचकर दिखाएँ"],
        "No plan usage yet": ["Aún sin uso del plan", "Pas encore d'utilisation", "Noch keine Nutzung", "Ainda sem uso do plano", "Nessun utilizzo ancora", "まだ利用はありません", "아직 사용량 없음", "暂无用量", "अभी कोई उपयोग नहीं"],
        "Done. Take a break.": ["Listo. Tómate un descanso.", "Terminé. Faites une pause.", "Fertig. Mach eine Pause.", "Pronto. Faça uma pausa.", "Fatto. Fai una pausa.", "完了。ひと休みしましょう。", "완료. 잠시 쉬세요.", "完成了，休息一下吧。", "हो गया। थोड़ा आराम करें।"],
        "Save as image": ["Guardar como imagen", "Enregistrer en image", "Als Bild sichern", "Salvar como imagem", "Salva come immagine", "画像として保存", "이미지로 저장", "存为图片", "छवि के रूप में सहेजें"],
        "words dictated": ["palabras dictadas", "mots dictés", "diktierte Wörter", "palavras ditadas", "parole dettate", "音声入力した語数", "받아쓴 단어", "听写字数", "बोलकर लिखे शब्द"],
        "saved typing": ["de escritura ahorrada", "de saisie épargnée", "Tippen gespart", "de digitação poupada", "di digitazione risparmiata", "入力を節約", "타이핑 절약", "节省的打字时间", "टाइपिंग की बचत"],
        "words/min": ["palabras/min", "mots/min", "Wörter/Min.", "palavras/min", "parole/min", "語/分", "단어/분", "字/分钟", "शब्द/मिनट"],
        "runs": ["ejecuciones", "exécutions", "Läufe", "execuções", "esecuzioni", "実行", "실행", "次运行", "रन"],
        "tokens": ["tokens", "jetons", "Tokens", "tokens", "token", "トークン", "토큰", "令牌", "टोकन"],
        "most used": ["más usado", "le plus utilisé", "meistgenutzt", "mais usado", "più usato", "最も使用", "가장 많이 사용", "最常用", "सबसे ज़्यादा इस्तेमाल"],
        "water (est.)": ["agua (est.)", "eau (est.)", "Wasser (gesch.)", "água (est.)", "acqua (stima)", "水 (推定)", "물 (추정)", "用水 (估计)", "पानी (अनुमान)"],
        "is asking you": ["te pregunta", "vous pose une question", "fragt dich", "está te perguntando", "ti chiede", "が質問しています", "이(가) 묻고 있어요", "在问你", "आपसे पूछ रहा है"],
        "at work": ["trabajando", "au travail", "bei der Arbeit", "trabalhando", "al lavoro", "仕事中", "작업 중", "工作中", "काम पर"],
        "Chat": ["Chat", "Discussion", "Chat", "Chat", "Chat", "チャット", "채팅", "聊天", "चैट"],
        "Shelf": ["Estante", "Étagère", "Ablage", "Estante", "Ripiano", "棚", "선반", "架子", "शेल्फ़"],
        "Focus": ["Enfoque", "Concentration", "Fokus", "Foco", "Concentrazione", "集中", "집중", "专注", "फ़ोकस"],
        "Clips": ["Recortes", "Presse-papiers", "Ablagen", "Recortes", "Appunti", "クリップ", "클립", "剪贴", "क्लिप"],
        "Mail": ["Correo", "Mail", "Mail", "E-mail", "Posta", "メール", "메일", "邮件", "मेल"],
        "Recap": ["Resumen", "Récap", "Rückblick", "Resumo", "Riepilogo", "まとめ", "요약", "回顾", "सारांश"],
        "Track my package ": ["Rastrear mi paquete ", "Suivre mon colis ", "Mein Paket verfolgen ", "Rastrear meu pacote ", "Traccia il mio pacco ", "荷物を追跡 ", "택배 조회 ", "追踪我的包裹 ", "मेरा पैकेज ट्रैक करें "],
        "Cancel my subscription to ": ["Cancelar mi suscripción a ", "Résilier mon abonnement à ", "Mein Abo kündigen bei ", "Cancelar minha assinatura de ", "Annulla il mio abbonamento a ", "解約する: ", "구독 해지: ", "取消我的订阅：", "मेरी सदस्यता रद्द करें: "],
        "Find a table for 2 tonight near ": ["Mesa para 2 esta noche cerca de ", "Une table pour 2 ce soir près de ", "Tisch für 2 heute Abend nahe ", "Mesa para 2 hoje à noite perto de ", "Un tavolo per 2 stasera vicino a ", "今夜2名で予約、場所: ", "오늘 밤 2명 자리, 위치: ", "今晚两人桌，在附近：", "आज रात 2 लोगों की टेबल, पास में: "],
        "Remind me at 5pm to ": ["Recuérdame a las 5 de la tarde ", "Rappelle-moi à 17 h de ", "Erinnere mich um 17 Uhr an ", "Lembre-me às 17h de ", "Ricordami alle 17 di ", "午後5時に知らせて: ", "오후 5시에 알려줘: ", "下午5点提醒我：", "शाम 5 बजे याद दिलाएँ: "],
        "Cheapest flight to ": ["Vuelo más barato a ", "Vol le moins cher pour ", "Günstigster Flug nach ", "Voo mais barato para ", "Volo più economico per ", "最安のフライト: ", "가장 싼 항공편: ", "最便宜的航班去：", "सबसे सस्ती उड़ान: "],
        "Summarize my unread mail": ["Resume mi correo sin leer", "Résume mes mails non lus", "Fasse meine ungelesenen Mails zusammen", "Resuma meus e-mails não lidos", "Riassumi la posta non letta", "未読メールを要約", "읽지 않은 메일 요약", "总结我的未读邮件", "मेरे बिना पढ़े मेल का सारांश दें"],
    ]
}

/// The island's words in the chosen language (English when there is no translation).
func T(_ en: String) -> String {
    guard L10n.lang != "en", let row = L10n.table[en], let i = L10n.languages.firstIndex(of: L10n.lang), i - 1 < row.count, i >= 1 else { return en }
    return row[i - 1]
}
