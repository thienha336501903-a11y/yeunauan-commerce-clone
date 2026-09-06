export function isSalePaused(course) {
  return course?.raw_data?.salePaused === true;
}

export function isCourseForSale(course) {
  return course?.active === true && !isSalePaused(course);
}
