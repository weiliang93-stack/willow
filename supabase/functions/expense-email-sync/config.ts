// Default card mapping and category fallbacks, copied from the nightly
// routine's own instructions (Sep 2026). Overridable without a redeploy by
// writing app_state app "expense_sync" -> { config: {...} } (any key given
// there replaces the default below wholesale).

import type { SyncConfig } from "./rules.ts";

export const DEFAULT_CONFIG: SyncConfig = {
  cardMap: {
    "3014": { cardId: "msjivaj3mypi2" }, // DBS Women World
    "4828": { split: "overseas", foreign: "msjiu41k2t7yo", local: "msjitr13dp43f" }, // UOB Visa Signature
    "3602": { split: "online", online: "msjiuwsowo52n", local: "msjiulkkaz6nm" }, // UOB Preferred Platinum
    "6110": { cardId: "msjit3wwnhtjh" }, // UOB Lady
    "2101": { cardId: "msx1hsbcrevo1" }, // HSBC Revolution
    "3399": { cardId: "msx1scbbeyond1" }, // StanChart Beyond
    "4637": { cardId: "msx1uobpvri01" }, // UOB PVRI
    "3051": { cardId: "msx1uobkris01" }, // UOB KrisFlyer
    "8959": { cardId: "uob_lady_supp_8959" }, // UOB Lady supplementary (wife's) - exclusionRule routes it
    "3902": { cardId: "citi_rewards_3902" }, // Citi Rewards - exclusionRule routes it
  },
  onlineMerchantHints: [
    "grab", "gojek", "shopee", "lazada", "amazon", "taobao", "qoo10", "foodpanda", "deliveroo", "netflix", "spotify",
    "apple.com", "itunes", "google", "youtube", "disney", "openai", "anthropic", "claude", "klook", "agoda", "booking.com",
    "airbnb", "trip.com", "expedia", "steam", "playstation", "nintendo", "microsoft", "adobe", "zoom", "notion", "paypal",
    "stripe", "www.", ".com", "online", "app pay", "krispay",
  ],
  // Tried after the owner's own categoryRules; anything still unmatched gets
  // a Haiku guess (or Shopping if no API key) and a Telegram "change?" prompt.
  categoryKeywords: [
    { merchantPattern: "cabcharge", category: "Transport" },
    { merchantPattern: "cdg", category: "Transport" },
    { merchantPattern: "comfortdelgro", category: "Transport" },
    { merchantPattern: "bus/mrt", category: "Transport" },
    { merchantPattern: "simplygo", category: "Transport" },
    { merchantPattern: "tada", category: "Transport" },
    { merchantPattern: "shell", category: "Transport" },
    { merchantPattern: "esso", category: "Transport" },
    { merchantPattern: "fairprice", category: "Food" },
    { merchantPattern: "cold storage", category: "Food" },
    { merchantPattern: "sheng siong", category: "Food" },
    { merchantPattern: "giant", category: "Food" },
    { merchantPattern: "guardian", category: "Personal Care" },
    { merchantPattern: "watsons", category: "Personal Care" },
    { merchantPattern: "clinic", category: "Health" },
    { merchantPattern: "pharmacy", category: "Health" },
    { merchantPattern: "medilist", category: "Health" },
    { merchantPattern: "singtel", category: "Bills" },
    { merchantPattern: "starhub", category: "Bills" },
    { merchantPattern: "m1 limited", category: "Bills" },
    { merchantPattern: "sp digital", category: "Bills" },
    { merchantPattern: "sp services", category: "Bills" },
    { merchantPattern: "netflix", category: "Entertainment" },
    { merchantPattern: "spotify", category: "Entertainment" },
    { merchantPattern: "disney", category: "Entertainment" },
    { merchantPattern: "golden village", category: "Entertainment" },
    { merchantPattern: "shaw theatres", category: "Entertainment" },
  ],
};
