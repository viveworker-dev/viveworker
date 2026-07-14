function isContainer(value) {
  return Boolean(value) && typeof value === "object";
}

function isArrayPointerSegment(segment) {
  return segment === "-" || /^\d+$/u.test(String(segment || ""));
}

function decodeJsonPointer(pointer) {
  if (Array.isArray(pointer)) {
    return pointer.map((segment) => String(segment));
  }
  if (!pointer || pointer === "/") {
    return [];
  }
  return String(pointer)
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function cloneContainer(value, nextSegment = "") {
  if (Array.isArray(value)) {
    return value.slice();
  }
  if (isContainer(value)) {
    return { ...value };
  }
  return isArrayPointerSegment(nextSegment) ? [] : {};
}

function arrayIndex(segment, length, { allowEnd = false } = {}) {
  if (segment === "-") {
    return allowEnd ? length : -1;
  }
  const parsed = Number.parseInt(String(segment), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return -1;
  }
  if (parsed < length || (allowEnd && parsed === length)) {
    return parsed;
  }
  return -1;
}

function readPointerChild(container, segment) {
  if (Array.isArray(container)) {
    const index = arrayIndex(segment, container.length, { allowEnd: true });
    return index >= 0 && index < container.length ? container[index] : undefined;
  }
  return isContainer(container) ? container[segment] : undefined;
}

function writeObjectKey(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function writePointerChild(container, segment, value) {
  if (Array.isArray(container)) {
    const index = arrayIndex(segment, container.length, { allowEnd: true });
    if (index < 0) return false;
    if (index === container.length) container.push(value);
    else container[index] = value;
    return true;
  }
  writeObjectKey(container, segment, value);
  return true;
}

function applyLeafOperation(container, segment, operation, value) {
  if (Array.isArray(container)) {
    if (operation === "add") {
      const index = arrayIndex(segment, container.length, { allowEnd: true });
      if (index < 0) return false;
      if (index === container.length) container.push(value);
      else container.splice(index, 0, value);
      return true;
    }

    const index = arrayIndex(segment, container.length);
    if (index < 0) return false;
    if (operation === "remove") container.splice(index, 1);
    else if (operation === "replace") container[index] = value;
    else return false;
    return true;
  }

  if (operation === "remove") {
    delete container[segment];
    return true;
  }
  if (operation === "add" || operation === "replace") {
    writeObjectKey(container, segment, value);
    return true;
  }
  return false;
}

export function applyJsonPatch(document, patch) {
  const operation = String(patch?.op || "");
  if (!["add", "remove", "replace"].includes(operation)) {
    return document;
  }

  const pathSegments = decodeJsonPointer(patch.path);
  if (pathSegments.length === 0) {
    if (operation === "remove") return {};
    return patch.value;
  }

  const root = cloneContainer(document, pathSegments[0]);
  let sourceNode = document;
  let targetNode = root;

  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index];
    const nextSegment = pathSegments[index + 1];
    const sourceChild = readPointerChild(sourceNode, segment);
    const targetChild = cloneContainer(sourceChild, nextSegment);
    if (!writePointerChild(targetNode, segment, targetChild)) {
      return document;
    }
    sourceNode = sourceChild;
    targetNode = targetChild;
  }

  const changed = applyLeafOperation(targetNode, pathSegments.at(-1), operation, patch.value);
  return changed ? root : document;
}

export function applyJsonPatches(document, patches) {
  let next = isContainer(document) ? document : {};
  for (const patch of Array.isArray(patches) ? patches : []) {
    next = applyJsonPatch(next, patch);
  }
  return next;
}
