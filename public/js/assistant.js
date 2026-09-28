// TaskFlow assistant: turns a goal into small steps you can add as to-dos.
(function (root) {
  const plans = {
    passport: {
      title: 'Passport Renewal Plan',
      steps: ['Check your current passport expiry date', 'Download and complete the DS-82 renewal form from travel.state.gov', 'Take a new passport photo that meets the requirements', 'Gather supporting documents (old passport, ID)', 'Prepare the payment', 'Mail your application, or go in person if it’s urgent', 'Track your application status online'],
    },
    grocery: {
      title: 'Grocery & Meal Planning',
      steps: ['Check what you already have in your fridge and pantry', 'Decide on 4–5 meals for the week', 'Write out the ingredients for each meal', 'Add pantry staples you’re running low on', 'Group items by store section', 'Stick to your list to avoid impulse buys'],
    },
    meal: {
      title: 'Weekly Meal Planning',
      steps: ['Choose a theme for each day (pasta Monday, tacos Tuesday…)', 'Pick 1–2 batch-cook meals to prep ahead', 'Plan quick 15-minute meals for busy nights', 'Check for ingredient overlap to reduce waste', 'Write your full grocery list before shopping'],
    },
    workout: {
      title: 'Weekly Workout Routine',
      steps: ['Monday: upper body strength (30 min)', 'Tuesday: cardio walk or jog (20–30 min)', 'Wednesday: lower body strength (30 min)', 'Thursday: rest or light stretching', 'Friday: full body workout (30 min)', 'Saturday: something active and fun', 'Sunday: full rest and recovery'],
    },
    clean: {
      title: 'Room Cleaning Breakdown',
      steps: ['Pick one area to start with', 'Take out trash and dirty dishes', 'Put away things that don’t belong in the room', 'Make your bed or clear the biggest surface', 'Wipe down surfaces', 'Vacuum or sweep the floor', 'Do a final scan and enjoy your clean space 🎉'],
    },
    bill: {
      title: 'Get On Top of Your Bills',
      steps: ['List every bill: credit cards, rent, phone, subscriptions', 'Write down each due date and usual amount', 'Add each one to TaskFlow as a monthly bill', 'Turn on “1 day before” and “on the day” reminders', 'Set up autopay for the minimum payment where you can', 'Check your balances once a week'],
    },
    budget: {
      title: 'Simple Monthly Budget',
      steps: ['Add up your monthly income after taxes', 'List fixed costs (rent, bills, transport)', 'Set a weekly amount for food and fun', 'Pick a savings amount, even a small one', 'Track spending for two weeks', 'Adjust where the numbers surprised you'],
    },
    goal: {
      title: 'Breaking Down a Big Goal',
      steps: ['Write your goal as a clear, specific statement', 'Identify the 3–5 major milestones', 'Break each milestone into small weekly actions', 'Set a realistic target date for each milestone', 'Schedule time in your calendar for each action', 'Review progress weekly and adjust', 'Celebrate small wins along the way'],
    },
    stress: {
      title: 'Managing Stress & Overwhelm',
      steps: ['Take 5 deep breaths: in for 4, out for 6', 'Write down everything on your mind', 'Circle only the 3 most urgent items', 'Break the #1 item into two small steps', 'Do one small step — just one', 'Give yourself credit for showing up today', 'Schedule a real break into your day'],
    },
    study: {
      title: 'Study Session Plan',
      steps: ['Gather all your materials before you start', 'Set a specific goal (“finish chapter 3”, not “study”)', 'Work 25 minutes, then take a 5-minute break', 'Put your phone on Do Not Disturb', 'After 4 rounds, take a 20-minute break', 'Review the key points before ending', 'Reward yourself when you’re done'],
    },
  };
  const aliases = { card: 'bill', rent: 'bill', pay: 'bill', money: 'budget', exam: 'study', homework: 'study', test: 'study', gym: 'workout', exercise: 'workout', food: 'meal', overwhelm: 'stress', anxious: 'stress', room: 'clean', house: 'clean' };

  const general = {
    title: 'General Plan',
    steps: ['Write down exactly what you want to accomplish', 'Break it into 3–5 smaller tasks you can do today', 'Do the most urgent one first', 'Pick a specific time to work on it', 'Remove distractions for at least 25 minutes', 'Review your progress and adjust'],
  };

  function suggest(text) {
    const input = String(text || '').toLowerCase();
    for (const key of Object.keys(plans)) if (input.includes(key)) return plans[key];
    for (const [word, key] of Object.entries(aliases)) if (input.includes(word)) return plans[key];
    return general;
  }

  root.Assistant = {
    suggest,
    prompts: [
      { label: '💳 Bills', text: 'Help me get on top of my bills' },
      { label: '📚 Study', text: 'Help me plan a study session' },
      { label: '💪 Workout', text: 'Help me plan a weekly workout routine' },
      { label: '🥗 Meals', text: 'Help me plan meals for the week' },
      { label: '🎯 Big goal', text: 'Help me break down a big goal into steps' },
    ],
  };
})(typeof self !== 'undefined' ? self : this);
