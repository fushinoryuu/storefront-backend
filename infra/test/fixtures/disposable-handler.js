// A `using` declaration is syntax that esbuild keeps only when the target is Node.js 26 or newer. For an older target it rewrites it into helper code, so the bundle of this file shows the target.
export const handler = async () => {
    using resource = { [Symbol.dispose]() {} };
    return { statusCode: 200, body: String(resource) };
};
