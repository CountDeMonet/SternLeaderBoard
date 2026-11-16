const localDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

for (const time of document.querySelectorAll('time[datetime]')) {
  time.textContent = localDateTime.format(new Date(time.dateTime));
}
