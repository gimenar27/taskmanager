// TaskFlow assistant: turns a goal into small steps you can add as to-dos (English and Spanish).
(function (root) {
  const plans = {
    passport: {
      en: { title: 'Passport Renewal Plan', steps: ['Check your current passport expiry date', 'Download and complete the DS-82 renewal form from travel.state.gov', 'Take a new passport photo that meets the requirements', 'Gather supporting documents (old passport, ID)', 'Prepare the payment', 'Mail your application, or go in person if it’s urgent', 'Track your application status online'] },
      es: { title: 'Plan para renovar el pasaporte', steps: ['Revisa la fecha de vencimiento de tu pasaporte', 'Descarga y llena el formulario de renovación DS-82 en travel.state.gov', 'Tómate una foto nueva que cumpla con los requisitos', 'Junta los documentos (pasaporte anterior, identificación)', 'Prepara el pago', 'Envía tu solicitud por correo, o ve en persona si es urgente', 'Revisa el estado de tu solicitud en línea'] },
    },
    grocery: {
      en: { title: 'Grocery & Meal Planning', steps: ['Check what you already have in your fridge and pantry', 'Decide on 4–5 meals for the week', 'Write out the ingredients for each meal', 'Add pantry staples you’re running low on', 'Group items by store section', 'Stick to your list to avoid impulse buys'] },
      es: { title: 'Compras y comidas de la semana', steps: ['Revisa lo que ya tienes en el refri y la despensa', 'Decide 4 o 5 comidas para la semana', 'Anota los ingredientes de cada comida', 'Agrega lo básico que se te está acabando', 'Agrupa todo por sección de la tienda', 'Sigue tu lista para no comprar de más'] },
    },
    meal: {
      en: { title: 'Weekly Meal Planning', steps: ['Choose a theme for each day (pasta Monday, tacos Tuesday…)', 'Pick 1–2 batch-cook meals to prep ahead', 'Plan quick 15-minute meals for busy nights', 'Check for ingredient overlap to reduce waste', 'Write your full grocery list before shopping'] },
      es: { title: 'Plan de comidas semanal', steps: ['Elige un tema para cada día (lunes de pasta, martes de tacos…)', 'Escoge 1 o 2 comidas para preparar con anticipación', 'Planea comidas rápidas de 15 minutos para las noches ocupadas', 'Repite ingredientes para desperdiciar menos', 'Escribe tu lista completa antes de ir a comprar'] },
    },
    workout: {
      en: { title: 'Weekly Workout Routine', steps: ['Monday: upper body strength (30 min)', 'Tuesday: cardio walk or jog (20–30 min)', 'Wednesday: lower body strength (30 min)', 'Thursday: rest or light stretching', 'Friday: full body workout (30 min)', 'Saturday: something active and fun', 'Sunday: full rest and recovery'] },
      es: { title: 'Rutina de ejercicio semanal', steps: ['Lunes: fuerza de la parte superior (30 min)', 'Martes: caminar o trotar (20–30 min)', 'Miércoles: fuerza de piernas (30 min)', 'Jueves: descanso o estiramientos suaves', 'Viernes: rutina de cuerpo completo (30 min)', 'Sábado: algo activo y divertido', 'Domingo: descanso total'] },
    },
    clean: {
      en: { title: 'Room Cleaning Breakdown', steps: ['Pick one area to start with', 'Take out trash and dirty dishes', 'Put away things that don’t belong in the room', 'Make your bed or clear the biggest surface', 'Wipe down surfaces', 'Vacuum or sweep the floor', 'Do a final scan and enjoy your clean space 🎉'] },
      es: { title: 'Limpiar el cuarto paso a paso', steps: ['Elige un área para empezar', 'Saca la basura y los platos sucios', 'Guarda lo que no va en el cuarto', 'Tiende la cama o despeja la superficie más grande', 'Limpia las superficies', 'Aspira o barre el piso', 'Da una última revisada y disfruta tu espacio limpio 🎉'] },
    },
    bill: {
      en: { title: 'Get On Top of Your Bills', steps: ['List every bill: credit cards, rent, phone, subscriptions', 'Write down each due date and usual amount', 'Add each one to TaskFlow as a monthly bill', 'Turn on “1 day before” and “on the day” reminders', 'Set up autopay for the minimum payment where you can', 'Check your balances once a week'] },
      es: { title: 'Organiza tus pagos', steps: ['Haz una lista de todos tus pagos: tarjetas, renta, teléfono, suscripciones', 'Anota la fecha de pago y el monto de cada uno', 'Agrega cada uno a TaskFlow como pago mensual', 'Activa los avisos de “1 día antes” y “el mismo día”', 'Pon el pago mínimo automático donde puedas', 'Revisa tus saldos una vez por semana'] },
    },
    budget: {
      en: { title: 'Simple Monthly Budget', steps: ['Add up your monthly income after taxes', 'List fixed costs (rent, bills, transport)', 'Set a weekly amount for food and fun', 'Pick a savings amount, even a small one', 'Track spending for two weeks', 'Adjust where the numbers surprised you'] },
      es: { title: 'Presupuesto mensual sencillo', steps: ['Suma tus ingresos del mes después de impuestos', 'Anota tus gastos fijos (renta, pagos, transporte)', 'Define un monto semanal para comida y diversión', 'Elige cuánto ahorrar, aunque sea poco', 'Anota tus gastos durante dos semanas', 'Ajusta donde los números te sorprendieron'] },
    },
    goal: {
      en: { title: 'Breaking Down a Big Goal', steps: ['Write your goal as a clear, specific statement', 'Identify the 3–5 major milestones', 'Break each milestone into small weekly actions', 'Set a realistic target date for each milestone', 'Schedule time in your calendar for each action', 'Review progress weekly and adjust', 'Celebrate small wins along the way'] },
      es: { title: 'Divide una meta grande', steps: ['Escribe tu meta de forma clara y específica', 'Identifica las 3 a 5 etapas principales', 'Divide cada etapa en acciones pequeñas por semana', 'Pon una fecha realista para cada etapa', 'Aparta tiempo en tu calendario para cada acción', 'Revisa tu avance cada semana y ajusta', 'Celebra los pequeños logros en el camino'] },
    },
    stress: {
      en: { title: 'Managing Stress & Overwhelm', steps: ['Take 5 deep breaths: in for 4, out for 6', 'Write down everything on your mind', 'Circle only the 3 most urgent items', 'Break the #1 item into two small steps', 'Do one small step — just one', 'Give yourself credit for showing up today', 'Schedule a real break into your day'] },
      es: { title: 'Manejar el estrés', steps: ['Respira profundo 5 veces: inhala en 4, exhala en 6', 'Escribe todo lo que tienes en la mente', 'Encierra solo las 3 cosas más urgentes', 'Divide la número 1 en dos pasos pequeños', 'Haz un paso pequeño, solo uno', 'Reconoce el esfuerzo que haces hoy', 'Aparta un descanso de verdad en tu día'] },
    },
    study: {
      en: { title: 'Study Session Plan', steps: ['Gather all your materials before you start', 'Set a specific goal (“finish chapter 3”, not “study”)', 'Work 25 minutes, then take a 5-minute break', 'Put your phone on Do Not Disturb', 'After 4 rounds, take a 20-minute break', 'Review the key points before ending', 'Reward yourself when you’re done'] },
      es: { title: 'Plan para estudiar', steps: ['Junta todo tu material antes de empezar', 'Ponte una meta concreta (“terminar el capítulo 3”, no “estudiar”)', 'Trabaja 25 minutos y descansa 5', 'Pon tu teléfono en No molestar', 'Después de 4 rondas, descansa 20 minutos', 'Repasa los puntos clave antes de terminar', 'Date un premio cuando acabes'] },
    },
  };

  // Words people might type (in either language) that point to a plan.
  const aliases = {
    passport: 'passport', pasaporte: 'passport',
    grocery: 'grocery', groceries: 'grocery', compras: 'grocery', super: 'grocery', súper: 'grocery', mandado: 'grocery',
    meal: 'meal', food: 'meal', comida: 'meal', comidas: 'meal', cocinar: 'meal',
    workout: 'workout', gym: 'workout', exercise: 'workout', ejercicio: 'workout', gimnasio: 'workout', entrenar: 'workout',
    clean: 'clean', room: 'clean', house: 'clean', limpiar: 'clean', cuarto: 'clean', casa: 'clean', limpieza: 'clean',
    bill: 'bill', card: 'bill', rent: 'bill', pay: 'bill', pago: 'bill', pagos: 'bill', tarjeta: 'bill', renta: 'bill', factura: 'bill', cuentas: 'bill',
    budget: 'budget', money: 'budget', presupuesto: 'budget', dinero: 'budget', ahorrar: 'budget',
    goal: 'goal', meta: 'goal', metas: 'goal', objetivo: 'goal',
    stress: 'stress', overwhelm: 'stress', anxious: 'stress', estrés: 'stress', estres: 'stress', ansiedad: 'stress', abrumad: 'stress',
    study: 'study', exam: 'study', homework: 'study', test: 'study', estudiar: 'study', examen: 'study', tarea: 'study',
  };

  const general = {
    en: { title: 'General Plan', steps: ['Write down exactly what you want to accomplish', 'Break it into 3–5 smaller tasks you can do today', 'Do the most urgent one first', 'Pick a specific time to work on it', 'Remove distractions for at least 25 minutes', 'Review your progress and adjust'] },
    es: { title: 'Plan general', steps: ['Escribe exactamente lo que quieres lograr', 'Divídelo en 3 a 5 tareas pequeñas que puedas hacer hoy', 'Haz primero la más urgente', 'Elige una hora concreta para trabajar en ello', 'Quita distracciones por al menos 25 minutos', 'Revisa tu avance y ajusta'] },
  };

  function suggest(text, lang) {
    const l = lang === 'es' ? 'es' : 'en';
    // Match the start of whole words, so "rent" doesn't match "current".
    const words = String(text || '').toLowerCase().split(/[^a-z0-9áéíóúñü]+/);
    for (const [alias, key] of Object.entries(aliases)) {
      if (words.some(w => w.startsWith(alias))) return plans[key][l];
    }
    return general[l];
  }

  const prompts = {
    en: [
      { label: '💳 Bills', text: 'Help me get on top of my bills' },
      { label: '📚 Study', text: 'Help me plan a study session' },
      { label: '💪 Workout', text: 'Help me plan a weekly workout routine' },
      { label: '🥗 Meals', text: 'Help me plan meals for the week' },
      { label: '🎯 Big goal', text: 'Help me break down a big goal into steps' },
    ],
    es: [
      { label: '💳 Pagos', text: 'Ayúdame a organizar mis pagos' },
      { label: '📚 Estudiar', text: 'Ayúdame a planear una sesión para estudiar' },
      { label: '💪 Ejercicio', text: 'Ayúdame a planear una rutina de ejercicio semanal' },
      { label: '🥗 Comidas', text: 'Ayúdame a planear las comidas de la semana' },
      { label: '🎯 Meta grande', text: 'Ayúdame a dividir una meta grande en pasos' },
    ],
  };

  root.Assistant = { suggest, prompts: lang => prompts[lang === 'es' ? 'es' : 'en'] };
})(typeof self !== 'undefined' ? self : this);
