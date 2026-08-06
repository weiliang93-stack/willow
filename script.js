// FitBot: a rule-based fitness chatbot. No AI model, no API calls —
// it just matches keywords in your message against a list of topics
// and picks a reply. That's what "rule-based" means.

const state = {
  name: null,
};

// Each rule has patterns to look for in the user's message and a list
// of possible replies (one is picked at random so it doesn't feel robotic).
const rules = [
  {
    patterns: ["hello", "hi", "hey", "yo"],
    responses: [
      "Hey there! Ready to talk fitness?",
      "Hi! What's on your mind today — workouts, food, or motivation?",
    ],
  },
  {
    patterns: ["my name is", "i'm ", "im ", "call me"],
    responses: null, // handled specially in getResponse()
  },
  {
    patterns: ["cardio", "run", "running", "jog"],
    responses: [
      "Cardio is great for your heart and stamina. Try starting with 20-30 minutes of brisk walking or jogging, 3x a week.",
      "For running, the golden rule is: most of your runs should feel 'comfortably hard', not maxed out. Save the sprints for once a week.",
    ],
  },
  {
    patterns: ["strength", "weights", "lifting", "muscle"],
    responses: [
      "For building strength, focus on compound moves — squats, push-ups, rows, deadlifts. 2-3 sessions a week is plenty to start.",
      "Progressive overload is key: slightly increase reps or weight over time so your muscles keep adapting.",
    ],
  },
  {
    patterns: ["yoga", "stretch", "flexibility", "mobility"],
    responses: [
      "Stretching after workouts (not before intense ones) helps recovery and flexibility. Even 10 minutes of yoga helps.",
      "Try a short mobility routine every morning — hips, shoulders, and ankles are the joints people neglect most.",
    ],
  },
  {
    patterns: ["rest", "recover", "sore", "injury"],
    responses: [
      "Rest days are part of training, not a break from it — muscles grow during recovery, not during the workout itself.",
      "If something is sharply painful (not just sore), stop and let it heal. Soreness is normal, pain is a warning sign.",
    ],
  },
  {
    patterns: ["protein", "diet", "eat", "nutrition", "food", "calories"],
    responses: [
      "A simple rule: aim for a palm-sized portion of protein at each meal (eggs, chicken, beans, tofu, yogurt all count).",
      "You don't need to overhaul your diet overnight — small swaps (water instead of soda, more veggies) add up fast.",
    ],
  },
  {
    patterns: ["water", "hydrate", "hydration"],
    responses: [
      "Good hydration target: about half your body weight (lbs) in ounces of water per day, more if you're sweating a lot.",
    ],
  },
  {
    patterns: ["tired", "lazy", "unmotivated", "motivation", "give up"],
    responses: [
      "Everyone has low-motivation days. Try committing to just 5 minutes — often that's enough to get you moving.",
      "Progress isn't about being motivated every day, it's about showing up on the days you're not. You've got this.",
    ],
  },
  {
    patterns: ["goal", "lose weight", "gain weight", "get fit", "beginner"],
    responses: [
      "Good goals are specific and small: '3 workouts this week' beats 'get fit'. What's one thing you could commit to this week?",
    ],
  },
  {
    patterns: ["thanks", "thank you", "thx"],
    responses: ["Anytime! Go crush your next workout 💪", "You're welcome — keep it up!"],
  },
  {
    patterns: ["bye", "goodbye", "see you"],
    responses: ["See you next time — stay consistent!", "Bye! Remember: small steps every day."],
  },
];

const fallbackResponses = [
  "I'm just a simple rule-based bot, so I didn't catch that. Try asking about workouts, nutrition, rest, or motivation!",
  "Not sure about that one yet — but I can help with cardio, strength training, stretching, food, or staying motivated.",
];

function getResponse(rawInput) {
  const input = rawInput.toLowerCase();

  // Special case: capture the user's name so we can personalize replies.
  const nameMatch = input.match(/(?:my name is|i'm|im|call me)\s+([a-z]+)/);
  if (nameMatch) {
    state.name = capitalize(nameMatch[1]);
    return `Nice to meet you, ${state.name}! What would you like to work on — cardio, strength, nutrition, or motivation?`;
  }

  for (const rule of rules) {
    if (!rule.responses) continue; // skip the special-cased name rule
    if (rule.patterns.some((pattern) => input.includes(pattern))) {
      const reply = pickRandom(rule.responses);
      return state.name ? maybeAddName(reply) : reply;
    }
  }

  return pickRandom(fallbackResponses);
}

function maybeAddName(reply) {
  // Occasionally personalize a reply with the user's name.
  return Math.random() < 0.3 ? `${state.name}, ${reply.charAt(0).toLowerCase()}${reply.slice(1)}` : reply;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// --- UI wiring ---

const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("user-input");

function addBubble(text, sender) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${sender}`;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;

  addBubble(text, "user");
  inputEl.value = "";

  setTimeout(() => {
    addBubble(getResponse(text), "bot");
  }, 400);
});

addBubble(
  "Hi! I'm FitBot 💪 What's your name, and what would you like to talk about — workouts, nutrition, or motivation?",
  "bot"
);
