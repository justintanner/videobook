const paths = {
  audio: 'M2 10v4m4-9v14m4-11v8m4-14v20m4-16v12m4-8v4',
  video: 'M3 5h13v14H3z M16 10l6-4v12l-6-4',
  film: 'M3 3h18v18H3z M7 3v18m10-18v18M3 8h4m10 0h4M3 16h4m10 0h4',
  prompt: 'M12 6C8 3 4 3 2 4v14c4-1 7 0 10 2 3-2 6-3 10-2V4c-3-1-7-1-10 2v14',
  character: 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0 M14 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0',
  analyze: 'M2 12h5l3-9 4 18 3-9h5',
  analysis: 'M8 3C3 3 8 11 3 12c5 1 0 9 5 9m8-18c5 0 0 8 5 9-5 1 0 9-5 9',
  goal: 'M4 22V3c6-4 10 4 16 0v11c-6 4-10-4-16 0',
  empty: 'M11 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z M19 2v4m-2-2h4',
}
function icon(name) {
  return `<svg aria-hidden="true" class="icon" viewBox="0 0 24 24"><path d="${paths[name]}"/></svg>`
}
const bodyText = text => `<p class="copy">${text}</p>`
const empty = text => `<div class="empty">${icon('empty')}<span>${text}</span></div>`
const slot = (title, detail) => `<div class="slot">${icon('audio')}<strong>${title}</strong>${detail}<small>Upload file</small></div>`
function wave(pending = false) {
  const bars = Array.from({ length: 60 }, (_, index) => {
    const peak = Math.abs(Math.sin(index * 0.31) * Math.cos(index * 0.11))
    const amplitude = pending ? 2 + index % 3 : 3 + peak * 55
    return `M${index * 4 + 2} ${78 - amplitude}v${2 * amplitude}`
  }).join(' ')

  const poster = '<svg class="wave" viewBox="0 0 240 156" preserveAspectRatio="none">' +
    '<path d="M0 78h240" stroke="currentColor" opacity=".16"/>' +
    `<path d="${bars}" stroke="currentColor" stroke-width="2" opacity="${pending ? 0.26 : 0.82}" stroke-linecap="round"/></svg>`
  const waiting = pending ? `<div class="pending">${icon('audio')}Waveform pending</div>` : ''
  const rail = '<div class="rail"><span>AAC · 48 kHz · stereo</span><time>0:12</time></div>'
  return poster + waiting + rail
}

function frames(first, last, range = true) {
  const halves = [first, last].map((image, index) => {
    const label = index === 0 ? 'First' : 'Last'
    const time = range ? ['0:03', '0:12'][index] : 'Frame pending'
    const picture = image ? '' : icon('film')
    return `<div class="frame ${image}">${picture}<label><b>${label}</b><span>${time}</span></label></div>`
  })
  return `<div class="frames">${halves.join('')}</div>`
}

function run(label, dock = false) {
  if (dock) return `<div class="dock"><i></i>${label}<b>0:08</b></div>`
  const symbol = label === 'Extracting' ? 'audio' : 'film'
  return `<div class="overlay clock">${icon(symbol)}<time>0:08</time></div>`
}

function fail(detail, dock = false) {
  return `<div class="${dock ? 'dock' : 'overlay'} error"><strong>Failed</strong>` +
    `<span>${detail}</span><em>Delete</em></div>`
}

const shotNames = ['Arrival', 'Crossing', 'Last light']

function analysis(count = 0, json = false, open = false) {
  const disclosure = '<div class="json">{} OUTPUT JSON</div>'
  if (open) {
    const example = '{\n  "shots": [\n    {"label": "Arrival"}\n  ]\n}'
    return `<div class="json-open">${disclosure}<pre>${example}</pre></div>`
  }

  const title = count ? `${count} shots` : 'Analysis pending'
  const duration = count ? '<time>0:12</time>' : ''
  const shots = shotNames.slice(0, count).map((name, index) => {
    const time = `0:0${index * 3}–0:0${(index + 1) * 3}`
    return `<div class="shot">${name}<small>${time}</small></div>`
  })
  const list = count ? `<div class="shots">${shots.join('')}</div>` : ''
  const overflow = count > 3 ? `<span>+${count - 3} more</span>` : ''
  return `<div class="summary"><div><strong>${title}</strong>${duration}</div>${list}${overflow}${json ? disclosure : ''}</div>`
}

function plan(phase, percent, rows = []) {
  const planning = phase === 'Planning'
  const title = planning ? 'Planning your short' : 'Last light at the pier'
  const note = { Review: 'Review the plan', Failed: 'Open to retry', Complete: 'Short ready · 0:12' }[phase] ?? ''
  const steps = rows.map((state, index) => {
    const tone = state === '✓ Done' || state === '● 0:08' ? 'live' : ''
    return `<div class="step"><span>0${index + 1}</span>${shotNames[index]}<small class="${tone}">${state}</small></div>`
  })
  const body = planning
    ? '<span>Follow the last ferry into the harbor.</span><div class="skeleton">' +
      '<i style="width:88%"></i><i style="width:72%"></i><i style="width:80%"></i></div>'
    : `<div class="steps">${steps.join('')}</div><span>${note}</span>`
  return `<div class="plan"><strong>${title}</strong>${body}<div class="progress"><i style="width:${percent}%"></i></div></div>`
}

const specimen = (title, body, options = {}) => ({ title, body, ...options })
const source = '← a1'
const clips = '← a1 · a2'
const destination = '→ c2'
const connected = { input: source }
const running = (label, input = source) => ({ frame: 'busy', flag: label, input })
const failed = (input = source) => ({ frame: 'failed', flag: 'Failed', input })
function editStates(hint, operation, inputs, error) {
  return [
    specimen('No clips', empty(hint)),
    specimen('One input', empty(hint), connected),
    specimen('Both inputs', empty(hint), { input: inputs }),
    specimen('Queued', run('Queued'), { input: inputs, flag: 'Queued' }),
    specimen(operation, run(operation), running(operation, inputs)),
    specimen('Job failed', fail(error), failed(inputs)),
  ]
}
const boards = [
  ['Audio', 'audio', 'audio', 'A rose waveform distinguishes recorded peaks from audio awaiting extraction.', [
    specimen('Empty audio slot', slot('Add audio', 'Recent media or drop a file')),
    specimen('Upload in progress', slot('Attaching media…', 'harbor.wav'), { flag: 'Uploading', frame: 'busy' }),
    specimen('Waveform pending', wave(true)),
    specimen('Peaks and duration', wave()),
    specimen('Versioned audio', wave(), { version: 'v2/2' }),
    specimen('Connected output', wave(), { output: destination }),
  ]],
  ['Extract audio', 'audio', 'audio', 'The video source stays visible while extraction produces a new audio track.', [
    specimen('No video', empty('Connect a video to extract audio')),
    specimen('Input connected', empty('Connect a video to extract audio'), connected),
    specimen('Extracting', run('Extracting'), running('Extracting')),
    specimen('Track awaiting peaks', wave(true), connected),
    specimen('Extracted track', wave(), { input: source, output: destination }),
    specimen('Extraction failed', fail('Source has no audio stream.'), failed()),
  ]],
  ['Split video', 'video', 'video', 'First and last frames keep independent previews and time labels.', [
    specimen('Unconfigured range', frames('', '', false)),
    specimen('Range set', frames('', ''), connected),
    specimen('First frame available', frames('land', ''), connected),
    specimen('Both frames available', frames('land', 'sunset'), { input: source, output: destination }),
    specimen('Splitting', run('Splitting'), running('Splitting')),
    specimen('Range failed', fail('Range exceeds clip length.'), failed()),
  ]],
  ['Concat', 'video', 'film', 'The input route groups clips in sequence. The working overlay covers the body.',
    editStates('Connect clip:0 and clip:1', 'Concatenating', clips, 'A source clip is unavailable.')],
  ['Splice', 'video', 'film', 'The first and second inputs identify the cut. Job status stays on the tile.',
    editStates('Connect first and second', 'Splicing', clips, 'Could not splice the two clips.')],
  ['Prompt', 'gen', 'prompt', 'Prompt text wraps from the upper left inside the dashed generation frame.', [
    specimen('Empty prompt', bodyText('@b1')),
    specimen('Short prompt', bodyText('Track the ferry at dusk.')),
    specimen('Multiline prompt', bodyText('Start at the pier.\nFollow the ferry.\nHold on the horizon.')),
    specimen('Long prompt', bodyText('A quiet harbor before sunrise. Keep the skyline still while the ferry crosses the frame. Let its wake reach the pier before cutting to the next shot.')),
    specimen('Selected', bodyText('Keep the horizon level.'), { frame: 'selected' }),
    specimen('Prompt sent downstream', bodyText('Track the ferry at dusk.'), { output: destination }),
  ]],
  ['Character', 'data', 'character', 'The reference is carried by the route. The neutral tile keeps the character picker cue.', [
    specimen('Unassigned', empty('Select a character')),
    specimen('Selected', empty('Select a character'), { frame: 'selected' }),
    specimen('One destination', empty('Select a character'), { output: destination }),
    specimen('Multiple destinations', empty('Select a character'), { output: '→ c2 +2' }),
  ]],
  ['Analyze', 'data', 'analyze', 'The instruction stays above a dock while the analysis job runs or needs attention.', [
    specimen('Empty instruction', bodyText('@b1')),
    specimen('Instruction entered', bodyText('Identify the cuts and describe each shot.')),
    specimen('Source connected', bodyText('Identify the cuts.'), connected),
    specimen('Queued', bodyText('Identify the cuts.') + run('Queued', true), { input: source, flag: 'Queued' }),
    specimen('Analyzing', bodyText('Identify the cuts.') + run('Analyzing', true), running('Analyzing')),
    specimen('Analysis failed', bodyText('Identify the cuts.') + fail('Video could not be read.', true), failed()),
  ]],
  ['Analysis', 'data', 'analysis', 'Shot labels and time ranges share a row. Structured output opens over the list.', [
    specimen('Pending', analysis()),
    specimen('One shot', analysis(1)),
    specimen('Three visible shots', analysis(3)),
    specimen('More than three shots', analysis(5)),
    specimen('Structured output', analysis(1, true)),
    specimen('JSON expanded', analysis(1, true, true)),
  ]],
  ['Goal', 'goal', 'goal', 'The purple corner identifies the goal. Numbered shot rows sit above the progress rail.', [
    specimen('Planning', plan('Planning', 0), { flag: 'Planning' }),
    specimen('Plan review', plan('Review', 0, ['Planned', 'Planned', 'Planned']), { flag: 'Review' }),
    specimen('Shots running', plan('Running', 33, ['✓ Done', '● 0:08', 'Waiting']), { flag: 'Running' }),
    specimen('Later shots waiting', plan('Running', 66, ['✓ Done', '✓ Done', 'Waiting']), { flag: 'Running' }),
    specimen('Shot failed', plan('Failed', 33, ['✓ Done', 'Failed', 'Waiting']), { frame: 'failed', flag: 'Failed' }),
    specimen('Short complete', plan('Complete', 100, ['✓ Done', '✓ Done', '✓ Done']), { flag: 'Complete' }),
  ]],
]

function renderBoard([name, family, symbol, description, states]) {
  const id = name.toLowerCase().replaceAll(' ', '-')
  const specimens = states.map(({ title, body, frame = '', input, output, flag, version }) => {
    const inputRoute = input ? `<span class="route">${input}</span>` : ''
    const outputRoute = output ? `<span class="route out">${output}</span>` : ''
    const setting = version ?? (name === 'Goal' && flag !== 'Planning' ? '3 clips · 12s　9:16' : '')
    const settings = setting ? `<span class="settings">${setting}</span>` : ''
    const header = `<header>${icon(symbol)}${name.toUpperCase()}${settings}</header>`
    const status = flag ? `<span class="flag">${flag}</span>` : ''
    const footer = '<footer><strong class="address">@b1</strong><span class="spacer"></span>' +
      `${status}<span class="menu">···</span></footer>`
    return `<figure><article class="tile ${family} ${frame}">${inputRoute}${header}<div class="body">${body}</div>` +
      `${footer}${outputRoute}</article><figcaption>${title}</figcaption></figure>`
  })
  return `<section id="${id}" class="board"><h1>${name} tile · states</h1><p class="intro">${description}</p>` +
    `<div class="specimens">${specimens.join('')}</div></section>`
}

document.querySelector('main').innerHTML = boards.map(renderBoard).join('')
