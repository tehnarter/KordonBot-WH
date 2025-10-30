import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import express from 'express';
import bodyParser from 'body-parser';
import {
  ensureSchema,
  addSubscription,
  removeSubscription,
  isSubscribed,
  getAllSubscriptions,
  canSendNotification,
  markNotificationSent
} from './../db.js';
// --- конфіг ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3001;
const ADMIN_CHAT = 'https://t.me/tehnar_u_a';
const GROUP_LINK = 'https://t.me/+IO0hlqWYkPUxYzg6';
const TMA_LINK = 'https://kordon.pp.ua';
const FB = 'https://www.facebook.com/profile.php?id=61579371541481&locale=uk_UA';
// --- прапори та напрямки ---
const FLAGS = { UA: '🇺🇦', PL: '🇵🇱', SK: '🇸🇰', HU: '🇭🇺', RO: '🇷🇴', MD: '🇲🇩' };
const DIRECTIONS = { PL: "🇵🇱 Польща", SK: "🇸🇰 Словаччина", HU: "🇭🇺 Угорщина", RO: "🇷🇴 Румунія", MD: "🇲🇩 Молдова" };

// --- ключі пунктів ---
const BORDER_KEYS = {
  "Краковець":"krakovets","Рава-Руська":"rava-ruska","Шегині":"shehyni","Устилуг":"ustyluh","Ягодин":"yahodyn",
  "Грушів":"hrushiv","Смільниця":"smilnytsia","Угринів":"uhryniv","Нижанковичі":"nyzhankovychi",
  "Корчова":"korchova","Гребенне":"grebenne","Медика":"medyka","Зосін":"zosin","Дорогуськ":"dorohusk",
  "Будомєж":"budomierz","Кросценко":"kroscienko","Долгобичув":"dolhobychuv","Мальховіце":"malkhovitse",
  "Ужгород":"uzhhorod","Малі Селменці":"mali-selmentsi","Вишнє Нємецьке":"vysne-nemecke","Вельке Селменце":"velke-selmentsi",
  "Чоп":"chop","Лужанка":"luzhanka","Дзвінкове":"dzvinkove","Захонь":"zahony","Берегдароц":"beregdaroc",
  "Астей":"astei","Порубне":"porubne","Дякове":"dyakove","Солотвино":"solotvyno","Сірет":"siret",
  "Халмеу":"halmeu","Сігет":"sighet","Могилів-Подільський":"mohyli-podilskyi","Мамалига":"mamalyha",
  "Росошани":"roshoshany","Отач":"otaci","Крива":"criva","Бричени":"briceni"
};

// --- зворотній пошук ---
const getBorderName = key => Object.keys(BORDER_KEYS).find(k => BORDER_KEYS[k] === key) || key;

// --- пункти ---
const BORDERS = {
  PL:{ UA:["Шегині","Краковець","Рава-Руська","Устилуг","Ягодин","Грушів","Смільниця","Угринів","Нижанковичі"], PL:["Медика","Корчова","Гребенне","Зосін","Дорогуськ","Будомєж","Кросценко","Долгобичув","Мальховіце"] },
  SK:{ UA:["Ужгород","Малі Селменці"], SK:["Вишнє Нємецьке","Вельке Селменце"] },
  HU:{ UA:["Чоп","Лужанка","Дзвінкове"], HU:["Захонь","Берегдароц","Астей"] },
  RO:{ UA:["Порубне","Дякове","Солотвино"], RO:["Сірет","Халмеу","Сігет"] },
  MD:{ UA:["Могилів-Подільський","Мамалига","Росошани"], MD:["Отач","Крива","Бричени"] }
};

// --- допоміжні функції ---
const chunk = (arr, size) => arr.reduce((rows, _, i) => (i % size === 0 ? [...rows, arr.slice(i,i+size)] : rows), []);
const formatTime = min => (!min || isNaN(min) || min === "-") ? "—" : (min < 60 ? `~${min} хв` : `~${Math.floor(min/60)} год ${min%60 ? min%60+' хв' : ''}`);

// --- головне меню ---
const mainMenu = () => ({
  reply_markup:{ inline_keyboard:[
  [{ text: ' Напрям🛣️', callback_data: 'show_queue' }, { text: 'Facebook📘', url: FB }],
  [{ text: 'Telegram💬', url: GROUP_LINK }, { text: 'Веб-сайт🌐', web_app: { url: TMA_LINK } }],
  [{ text: 'Контакт📝', url: ADMIN_CHAT }, { text: 'Закрити❌', callback_data: 'close_bot' }]
]}
});

// --- fetch черг ---
async function fetchQueueData(borderKey, hours=1){
  try{
    const res = await axios.get(`${process.env.API_URL}/api/get-border-data.php?name=${borderKey}&hours=${hours}&api_key=${process.env.API_KEY}`);
    const { queues, times } = res.data;
    return {
      queues:{ buses:queues?.bus??"-", cars:queues?.car??"-", tir:queues?.tir??"-", foot:queues?.pedestrian??"-" },
      times:{ buses:times?.bus??"-", cars:times?.car??"-", tir:times?.tir??"-", foot:times?.pedestrian??"-" }
    };
  }catch(e){ console.error("fetchQueueData:", e); return null; }
}

// --- Telegram Bot ---
const bot = new TelegramBot(token, { polling: false });
const app = express(); 
app.use(bodyParser.json());
app.post('/webhook', async (req,res)=>{ 
  try{ await bot.processUpdate(req.body); res.sendStatus(200); } 
  catch(e){ console.error(e); res.sendStatus(500); } 
});

// --- Ініціалізація ---
await ensureSchema();
await bot.setWebHook(WEBHOOK_URL);

// --- Зберігання останніх повідомлень ---
const lastMessages = new Map();
const MAX_SIMPLE = 5;
const MAX_QUEUE = 5;

function addMessage(chatId, messageId, type='simple'){
  if(!lastMessages.has(chatId)) lastMessages.set(chatId, []);
  const msgs = lastMessages.get(chatId);
  msgs.push({ id: messageId, time: Date.now(), type });
  
  const max = type === 'queue' ? MAX_QUEUE : MAX_SIMPLE;
  let typeMsgs = msgs.filter(m => m.type === type);
  while(typeMsgs.length > max){
    const old = typeMsgs.shift();
    bot.deleteMessage(chatId, old.id).catch(()=>{});
    const idx = msgs.findIndex(m => m.id === old.id);
    if(idx >= 0) msgs.splice(idx,1);
  }
  lastMessages.set(chatId, msgs);
}

// --- черга відправки ---
const sendQueue=[], delay=40; 
let sending=false;

const enqueueSend = (chatId, text, options={}, type='simple')=>{
  sendQueue.push({chatId, text, options, type});
  processQueue();
};

async function processQueue(){
  if(sending) return;
  sending=true;

  while(sendQueue.length){
    const {chatId, text, options, type} = sendQueue.shift();
    try {
      const sent = await bot.sendMessage(chatId, text, options);
      addMessage(chatId, sent.message_id, type);
    } catch(e){ console.error('sendMessage',e); }
    await new Promise(r=>setTimeout(r, delay));
  }

  sending=false;
}

// --- /start ---
bot.onText(/\/start/, msg => bot.sendMessage(msg.chat.id, `Привіт, ${msg.from.first_name||'Гість'}!`, mainMenu()));

// --- callback_query обробка ---
bot.on('callback_query', async q=>{
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const data = q.data;

  const safeEdit = async (text, options) => {
    try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options }); }
    catch (e) { if(!e.response?.body?.description?.includes("message is not modified")) console.error(e); }
  };

  const safeSend = async (text, options, type='simple') => { 
    try { const sent = await bot.sendMessage(chatId,text,options); addMessage(chatId,sent.message_id,type); } 
    catch(e){ console.error(e); } 
  };

  try{
    // --- навігація ---
    if(data==='close_bot') return safeEdit("Бот завершив роботу.", { reply_markup:{ inline_keyboard:[[ { text:'🔝 Головне меню', callback_data:'start_bot' } ]] } });
    if(data==='start_bot') return safeSend('Головне меню:', mainMenu());
    if(data==='show_queue'){
      const flows = Object.keys(DIRECTIONS).flatMap(code=>[
        { text:`${FLAGS.UA} Україна → ${DIRECTIONS[code]}`, cb:`flow_UA_${code}` },
        { text:`${DIRECTIONS[code]} → ${FLAGS.UA} Україна`, cb:`flow_${code}_UA` }
      ]);
      return safeSend("Оберіть напрямок:", { reply_markup:{ inline_keyboard: chunk(flows.map(f=>({ text:f.text, callback_data:f.cb })),2) } });
    }

    // --- вибір пункту ---
    if(data.startsWith('flow_')){
      const [,from,to] = data.split('_');
      const code = from==='UA'?to:from;
      const sideKey = from==='UA'?'UA':code;
      const list = BORDERS[code]?.[sideKey] || [];
      if(!list.length) return safeSend("Нема пунктів 😔");
      const buttons = list.map(n=>({ text:`${FLAGS[from]} ${n} ${FLAGS[to]}`, callback_data:`border|${from}|${to}|${BORDER_KEYS[n]}` }));
      return safeSend(`Оберіть пункт (${FLAGS[from]} → ${FLAGS[to]}):`, { reply_markup:{ inline_keyboard: chunk(buttons,3) } });
    }

    // --- вибір кордону ---
    if(data.startsWith("border|")){
      const [,from,to,borderKey] = data.split("|");
      const borderName = getBorderName(borderKey);
      const subscribed = await isSubscribed(chatId,borderKey);
      const keyboard = { inline_keyboard:[
        [
          { text:'📊 Актуальні черги', callback_data:`refresh|${from}|${to}|${borderKey}` },
          { text: subscribed?'🔕 Відписатися':'🔔 Підписатися', callback_data:`subscribe|${from}|${to}|${borderKey}` }
        ],
        [
          { text:'🔝 Головне меню', callback_data:'start_bot' },
          { text:'❌ Закрити бота', callback_data:'close_bot' }
        ]
      ]};
      return safeSend(`Ви обрали пункт: ${borderName} (${FLAGS[from]} → ${FLAGS[to]}).`, { reply_markup: keyboard });
    }

    // --- оновлення черги ---
    if(data.startsWith("refresh|") || data.startsWith("send_queue|")){
      const isSend = data.startsWith("send_queue|");
      const [,from,to,borderKey] = data.split("|");
      const borderName = getBorderName(borderKey);

      if(isSend){
        const ok = await canSendNotification(chatId,borderKey);
        if(!ok) return safeSend(`⏳ Можна надсилати лише раз на 24 години.`);
      }

      const qData = await fetchQueueData(borderKey,1);
      if(!qData) return safeSend(`Немає даних для "${borderName}" 😔`);
      const subscribed = await isSubscribed(chatId,borderKey);

      let msg = isSend ? `📤 Надіслано чергу для "${borderName}":\n\n` : `Черги для "${borderName}":\n\n`;
      const cats = [
        { icon:"🚗", label:"Легкові", q:qData.queues.cars, t:qData.times.cars },
        { icon:"🚌", label:"Автобуси", q:qData.queues.buses, t:qData.times.buses },
        { icon:"🚛", label:"TIR", q:qData.queues.tir, t:qData.times.tir },
        { icon:"🚶", label:"Пішоходи", q:qData.queues.foot, t:qData.times.foot }
      ];
      cats.forEach(c=>msg+=`${c.icon} ${c.label}: ${c.q}\n⏱ Орієнтовний час: ${formatTime(c.t)}\n\n`);

      const keyboard = { inline_keyboard:[
        [
          { text:'📊 Актуальні черги', callback_data:`refresh|${from}|${to}|${borderKey}` },
          { text: subscribed?'🔕 Відписатися':'🔔 Підписатися', callback_data:`subscribe|${from}|${to}|${borderKey}` }
        ],
        [
          { text:'🔝 Головне меню', callback_data:'start_bot' },
          { text:'❌ Закрити бота', callback_data:'close_bot' }
        ]
      ]};

      enqueueSend(chatId,msg,{ reply_markup: keyboard }, isSend ? 'queue':'simple');
      if(isSend) await markNotificationSent(chatId,borderKey);
      bot.answerCallbackQuery(q.id).catch(console.error);
    }

    if(data.startsWith("subscribe|")){
  const [,from,to,borderKey] = data.split("|");
  const borderName = getBorderName(borderKey);
  const username = q.from?.username || q.from?.first_name || 'Гість';

  // --- перевірка чи вже підписаний ---
  if(await isSubscribed(chatId,borderKey)){
    await removeSubscription(chatId,borderKey);
    return safeSend(`🔕 Відписано від "${borderName}".`, 
      { reply_markup:{ inline_keyboard:[[ { text:'🔝 Головне меню', callback_data:'start_bot' } ]] } }
    );
  }

  // --- отримуємо всі підписки користувача ---
  const allSubs = await getAllSubscriptions();
  const mySubs = allSubs.filter(s => s.user_id === chatId);

  // --- перевірка кількості підписок ---
  if(mySubs.length >= 5){
    return safeSend(`❌ Ви не можете підписатися більше ніж на 5 кордонів одночасно.\nБудь ласка, відпишіться від одного з існуючих кордонів.`, 
      { reply_markup:{ inline_keyboard:[[ { text:'🔝 Головне меню', callback_data:'start_bot' } ]] } }
    );
  }

  // --- додаємо підписку ---
  await addSubscription({ userId:chatId, username, borderKey, from, to });
  return safeSend(`✅ Підписка на "${borderName}" оформлена!`, 
    { reply_markup:{ inline_keyboard:[[ { text:'🔝 Головне меню', callback_data:'start_bot' } ]] } }
  );
}

    // --- відписка ---
    if(data.startsWith("unsubscribe|")){
      const [,borderKey] = data.split("|");
      const borderName = getBorderName(borderKey);
      await removeSubscription(chatId,borderKey);
      return safeSend(`🔕 Відписано від "${borderName}".`, { reply_markup:{ inline_keyboard:[[ { text:'🔝 Головне меню', callback_data:'start_bot' } ]] } });
    }

  }catch(e){ console.error("callback_query handler error:",e); }
});

// --- щогодинна розсилка ---
setInterval(async()=>{
  try{
    const subs = await getAllSubscriptions();
    const byBorder = subs.reduce((m,s)=>{ if(!m.has(s.border_key)) m.set(s.border_key,[]); m.get(s.border_key).push(s); return m; }, new Map());
    for(const [borderKey, group] of byBorder){
      const data = await fetchQueueData(borderKey,1); if(!data) continue;
      for(const sub of group){
        const f1 = FLAGS[sub.from_country]||sub.from_country;
        const f2 = FLAGS[sub.to_country]||sub.to_country;
        const borderName = getBorderName(borderKey);
        let msg = `🔔 Оновлення черг для "${borderName}" (${f1} → ${f2}):\n\n`;
        const cats = [
          {icon:"🚗", label:"Легкові", q:data.queues.cars, t:data.times.cars},
          {icon:"🚌", label:"Автобуси", q:data.queues.buses, t:data.times.buses},
          {icon:"🚛", label:"Фури", q:data.queues.tir, t:data.times.tir},
          {icon:"🚶", label:"Пішоходи", q:data.queues.foot, t:data.times.foot}
        ];
        cats.forEach(c=>msg+=`${c.icon} ${c.label}: ${c.q}\n⏱ Орієнтовний час: ${formatTime(c.t)}\n\n`);
        const keyboard = { inline_keyboard:[[ {text:'🔝 Головне меню',callback_data:'start_bot'},{text:'🔕 Відписатися',callback_data:`unsubscribe|${borderKey}`}]] };
        enqueueSend(sub.user_id,msg,{ reply_markup:keyboard }, 'queue');
      }
    }
  }catch(e){ console.error("Розсилка:",e); }
},3600*1000);

// --- старт сервера ---
app.listen(PORT, ()=>console.log(`Webhook бот запущено на порту ${PORT}`));

